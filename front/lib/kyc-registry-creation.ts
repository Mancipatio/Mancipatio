// Dual-signed `create_kyc_registry` (Talas 3.1 K5).
//
// The program needs two signers: the registry's KYC authority (it pays, owns
// the registry and seeds its address) and an Admin co-signer. When they are
// different keys on different devices, the two signatures are collected on a
// shared public document, the same way lib/issuer-recovery does it:
//
// * the document carries only TYPED terms (keys, jurisdiction codes, compute
//   budget, blockhash) and is bound to the network and its genesis hash;
// * every holder rebuilds the one transaction locally from those terms, so an
//   imported document can never slip in another instruction;
// * signatures are accepted only from the two named keys and are verified
//   over the exact message bytes before they are used;
// * live state (registry absent, Admin record active, pin, blockhash) and the
//   maintenance flag are re-checked before signing and again before sending,
//   and signing needs a wallet that can sign without sending.
//
// The runbook default (OD7) is simpler and needs none of this: one Admin
// creates the registry signing as both roles, then proposes the registry
// authority to the compliance key, which accepts at /account/roles.
import {
  address,
  appendTransactionMessageInstructions,
  assertIsFullySignedTransaction,
  assertIsSignatureBytes,
  assertIsTransactionWithinSizeLimit,
  blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  fetchEncodedAccount,
  getBase58Decoder,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getPublicKeyFromAddress,
  isTransactionPartialSigner,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  verifySignature,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
import type { SolanaClient } from "@solana/client";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  fetchMaybeAdmin,
  findAdminRecordPda,
  findKycRegistryPda,
  getCreateKycRegistryInstructionAsync,
} from "@/lib/generated/asset_registry";
import {
  MAX_COMPUTE_UNIT_LIMIT,
  setComputeUnitLimitInstruction,
  setComputeUnitPriceInstruction,
} from "@/lib/compute-budget";
import { jurisdictionBitmap } from "@/lib/jurisdiction-bitmap";
import { configuredKycRegistry } from "@/lib/kyc-registry-pin";
import { assertSiteWritable } from "@/lib/maintenance";
import type { Network } from "@/lib/network";
import { createNetworkVerifier, expectedGenesisHash } from "@/lib/network-identity";
import { DEFAULT_ADDRESS } from "@/lib/protocol-treasury";

type Rpc = SolanaClient["runtime"]["rpc"];

export type KycRegistryCreationEnvelope = {
  version: 1;
  kind: "create_kyc_registry";
  network: Network;
  genesisHash: string;
  /** Owns, pays for and seeds the registry; the fee payer. */
  kycAuthority: string;
  /** Any active Admin (OD5); co-signs the creation only. */
  adminAuthority: string;
  /** PDA(["kyc_registry", kycAuthority]). */
  registry: string;
  /** Sorted, unique ISO numeric codes in 1..1023, disjoint from `blocked`. */
  approved: number[];
  blocked: number[];
  /** 1..1_400_000. */
  computeUnitLimit: number;
  /** Decimal u64 string, 0..MAX_ENVELOPE_CU_PRICE. */
  computeUnitPriceMicroLamports: string;
  blockhash: string;
  lastValidBlockHeight: string;
  /** base58 signatures keyed by signer address (only the two named keys). */
  signatures: Record<string, string>;
};

export const KYC_REGISTRY_CREATION_KIND = "create_kyc_registry";
/** The largest document accepted (the full ISO lists fit easily). */
export const MAX_ENVELOPE_BYTES = 16 * 1024;
/** create_kyc_registry needs well under this (one PDA init + one Admin read). */
export const DEFAULT_COMPUTE_UNIT_LIMIT = 100_000;
/**
 * The highest priority fee an envelope may carry, in micro-lamports per
 * compute unit: 5 lamports / CU, i.e. at most 0.0005 SOL at the default
 * limit and 0.007 SOL at the 1.4M ceiling. Both signers see the value.
 */
export const MAX_ENVELOPE_CU_PRICE = BigInt(5_000_000);
/**
 * Mainnet default priority fee (micro-lamports / CU) until Talas 4 prices it
 * dynamically: 0.00001 SOL at the default limit. Devnet, testnet and
 * localnet default to 0.
 */
export const DEFAULT_MAINNET_CU_PRICE = BigInt(100_000);

/** The compute budget a new envelope starts with on `network`. */
export function defaultComputeBudget(network: Network): {
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: string;
} {
  const price = network === "mainnet" ? DEFAULT_MAINNET_CU_PRICE : BigInt(0);
  return {
    computeUnitLimit: DEFAULT_COMPUTE_UNIT_LIMIT,
    computeUnitPriceMicroLamports: (price > MAX_ENVELOPE_CU_PRICE ? MAX_ENVELOPE_CU_PRICE : price).toString(),
  };
}

function fail(message: string): never {
  throw new Error(`Invalid registry creation document: ${message}`);
}

function validAddress(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} is missing`);
  try {
    address(value);
  } catch {
    fail(`${label} is not a valid address`);
  }
  if (value === DEFAULT_ADDRESS) fail(`${label} cannot be the default address`);
  return value;
}

function codeList(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) fail(`${label} must be a list of jurisdiction codes`);
  let previous = 0;
  for (const code of value) {
    if (!Number.isInteger(code) || code < 1 || code > 1023) {
      fail(`${label} contains ${String(code)}, outside 1..1023`);
    }
    if (code <= previous) fail(`${label} must be sorted ascending without duplicates`);
    previous = code;
  }
  return [...value] as number[];
}

/** Sorted, unique codes (for building a new envelope from a selection). */
export function normalizeCodes(codes: Iterable<number>): number[] {
  return [...new Set(codes)].sort((a, b) => a - b);
}

/** The registry a KYC authority creates: PDA(["kyc_registry", kycAuthority]). */
export async function kycRegistryAddressFor(kycAuthority: Address): Promise<Address> {
  return (await findKycRegistryPda({ authority: kycAuthority }))[0];
}

/**
 * Parses and validates a document for `network`, returning a canonical copy
 * holding only the typed terms. Rejects: > 16 KB, another network or
 * genesis, invalid or default addresses, unrepresentable / overlapping /
 * unsorted codes, a registry that is not PDA(kycAuthority), an out-of-range
 * compute budget and signatures of any key but the two named signers.
 */
export async function parseKycRegistryCreation(
  raw: string,
  network: Network,
): Promise<KycRegistryCreationEnvelope> {
  if (raw.length > MAX_ENVELOPE_BYTES) fail("the document is too large");
  let e: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("not a JSON object");
    e = parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Invalid registry creation document")) throw err;
    fail("not valid JSON");
  }
  if (e.version !== 1 || e.kind !== KYC_REGISTRY_CREATION_KIND) fail("unknown version or kind");
  if (e.network !== network || e.genesisHash !== expectedGenesisHash(network)) {
    fail(`it was prepared for another network (this site runs ${network})`);
  }
  const kycAuthority = validAddress(e.kycAuthority, "KYC authority");
  const adminAuthority = validAddress(e.adminAuthority, "Admin co-signer");
  const registry = validAddress(e.registry, "registry");
  if (registry !== (await kycRegistryAddressFor(address(kycAuthority)))) {
    fail("the registry is not the address the KYC authority creates");
  }
  const approved = codeList(e.approved, "approved");
  const blocked = codeList(e.blocked, "blocked");
  const approvedSet = new Set(approved);
  const overlap = blocked.find((c) => approvedSet.has(c));
  if (overlap !== undefined) fail(`jurisdiction ${overlap} is both approved and blocked`);
  const limit = e.computeUnitLimit;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_COMPUTE_UNIT_LIMIT) {
    fail(`the compute unit limit must be 1..${MAX_COMPUTE_UNIT_LIMIT}`);
  }
  const price = e.computeUnitPriceMicroLamports;
  if (typeof price !== "string" || !/^(0|[1-9]\d{0,19})$/.test(price) || BigInt(price) > MAX_ENVELOPE_CU_PRICE) {
    fail(`the compute unit price must be a whole number of micro-lamports, 0..${MAX_ENVELOPE_CU_PRICE}`);
  }
  if (typeof e.blockhash !== "string") fail("blockhash is missing");
  try {
    blockhash(e.blockhash);
  } catch {
    fail("invalid blockhash");
  }
  if (typeof e.lastValidBlockHeight !== "string" || !/^\d{1,20}$/.test(e.lastValidBlockHeight)) {
    fail("invalid last valid block height");
  }
  const sigs = e.signatures;
  if (!sigs || typeof sigs !== "object" || Array.isArray(sigs)) fail("signatures must be an object");
  const signatures: Record<string, string> = {};
  for (const [key, value] of Object.entries(sigs as Record<string, unknown>)) {
    if ((key !== kycAuthority && key !== adminAuthority) || typeof value !== "string") {
      throw new Error("Unexpected registry creation signer");
    }
    signatures[key] = value;
  }
  return {
    version: 1,
    kind: KYC_REGISTRY_CREATION_KIND,
    network,
    genesisHash: e.genesisHash as string,
    kycAuthority,
    adminAuthority,
    registry,
    approved,
    blocked,
    computeUnitLimit: limit as number,
    computeUnitPriceMicroLamports: price,
    blockhash: e.blockhash,
    lastValidBlockHeight: e.lastValidBlockHeight,
    signatures,
  };
}

/**
 * The live checks, before preparing, signing and sending: the network, the
 * registry still absent (confirmed), the co-signer's Admin record active
 * (finalized; any Admin qualifies, OD5), the pin (mandatory on mainnet and
 * equal to the registry) and the blockhash still valid.
 */
async function assertCreationLive(
  rpc: Rpc,
  e: KycRegistryCreationEnvelope,
  pinned: Address | null,
): Promise<void> {
  await createNetworkVerifier(rpc, e.network)();
  if (pinned === null && e.network === "mainnet") {
    throw new Error("Mainnet requires the pinned platform registry (NEXT_PUBLIC_KYC_REGISTRY) before a registry is created.");
  }
  if (pinned !== null && pinned !== e.registry) {
    throw new Error(`This registry (${e.registry}) is not the pinned platform registry (${pinned}).`);
  }
  const [adminRecord] = await findAdminRecordPda({ authority: address(e.adminAuthority) });
  const [existing, admin] = await Promise.all([
    fetchEncodedAccount(rpc as unknown as Parameters<typeof fetchEncodedAccount>[0], address(e.registry), {
      commitment: "confirmed",
      abortSignal: AbortSignal.timeout(10_000),
    }),
    fetchMaybeAdmin(rpc, adminRecord, { commitment: "finalized", abortSignal: AbortSignal.timeout(10_000) }),
  ]);
  if (existing.exists) throw new Error(`The KYC registry ${e.registry} already exists.`);
  if (!admin.exists || admin.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS || admin.data.admin !== e.adminAuthority) {
    throw new Error("The Admin co-signer has no active Admin record.");
  }
  const valid = await rpc
    .isBlockhashValid(blockhash(e.blockhash), { commitment: "confirmed" })
    .send({ abortSignal: AbortSignal.timeout(10_000) });
  if (!valid.value) {
    throw new Error(
      "This document's blockhash expired. Prepare a new document and collect both signatures again.",
    );
  }
}

export type KycRegistryCreationInput = {
  kycAuthority: Address;
  adminAuthority: Address;
  approved: Iterable<number>;
  blocked: Iterable<number>;
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: string;
};

type PinOption = { pinned?: Address | null };

/** Builds a fresh document (latest blockhash, no signatures) after the live checks. */
export async function prepareKycRegistryCreation(
  rpc: Rpc,
  network: Network,
  input: KycRegistryCreationInput,
  opts: PinOption = {},
): Promise<KycRegistryCreationEnvelope> {
  const pinned = opts.pinned !== undefined ? opts.pinned : configuredKycRegistry();
  await createNetworkVerifier(rpc, network)();
  const lifetime = await rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send({ abortSignal: AbortSignal.timeout(10_000) });
  const budget = defaultComputeBudget(network);
  const e = await parseKycRegistryCreation(
    JSON.stringify({
      version: 1,
      kind: KYC_REGISTRY_CREATION_KIND,
      network,
      genesisHash: expectedGenesisHash(network),
      kycAuthority: input.kycAuthority,
      adminAuthority: input.adminAuthority,
      registry: await kycRegistryAddressFor(input.kycAuthority),
      approved: normalizeCodes(input.approved),
      blocked: normalizeCodes(input.blocked),
      computeUnitLimit: input.computeUnitLimit ?? budget.computeUnitLimit,
      computeUnitPriceMicroLamports: input.computeUnitPriceMicroLamports ?? budget.computeUnitPriceMicroLamports,
      blockhash: lifetime.value.blockhash,
      lastValidBlockHeight: String(lifetime.value.lastValidBlockHeight),
      signatures: {},
    }),
    network,
  );
  await assertCreationLive(rpc, e, pinned);
  return e;
}

/**
 * Rebuilds the one transaction from the typed terms: SetComputeUnitLimit,
 * SetComputeUnitPrice, then create_kyc_registry with bitmaps rebuilt from the
 * code lists; fee payer = the KYC authority. Every stored signature is
 * verified over the exact message bytes.
 */
export async function compileKycRegistryCreation(input: KycRegistryCreationEnvelope) {
  const e = await parseKycRegistryCreation(JSON.stringify(input), input.network);
  const kyc = createNoopSigner(address(e.kycAuthority));
  const admin = e.adminAuthority === e.kycAuthority ? kyc : createNoopSigner(address(e.adminAuthority));
  const create = await getCreateKycRegistryInstructionAsync({
    authority: kyc,
    adminAuthority: admin,
    approvedJurisdictions: jurisdictionBitmap(e.approved),
    blockedJurisdictions: jurisdictionBitmap(e.blocked),
  });
  if (create.accounts[3]?.address !== e.registry) {
    throw new Error("The rebuilt instruction does not create the reviewed registry");
  }
  const message = appendTransactionMessageInstructions(
    [
      setComputeUnitLimitInstruction(e.computeUnitLimit),
      setComputeUnitPriceInstruction(BigInt(e.computeUnitPriceMicroLamports)),
      create,
    ],
    setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: blockhash(e.blockhash), lastValidBlockHeight: BigInt(e.lastValidBlockHeight) },
      setTransactionMessageFeePayer(kyc.address, createTransactionMessage({ version: 0 })),
    ),
  );
  const unsigned = compileTransaction(message);
  const signatures = { ...unsigned.signatures };
  for (const [key, value] of Object.entries(e.signatures)) {
    const bytes = Uint8Array.from(getBase58Encoder().encode(value));
    assertIsSignatureBytes(bytes);
    if (!(await verifySignature(await getPublicKeyFromAddress(address(key)), bytes, unsigned.messageBytes))) {
      throw new Error("A registry creation signature does not match the reviewed terms");
    }
    signatures[address(key)] = bytes;
  }
  const transaction = { ...unsigned, signatures };
  assertIsTransactionWithinSizeLimit(transaction);
  return transaction;
}

/**
 * An imported document, parsed AND rebuilt: every stored signature is
 * verified over the exact message now, so a forged or mismatched signature
 * is refused at import instead of only at sign / submit time. Offline (no
 * RPC); the live checks still run before signing and sending.
 */
export async function inspectKycRegistryCreation(
  raw: string,
  network: Network,
): Promise<KycRegistryCreationEnvelope> {
  const e = await parseKycRegistryCreation(raw, network);
  await compileKycRegistryCreation(e);
  return e;
}

/**
 * Adds the connected signer's signature. The signer must be one of the two
 * named keys and able to sign without sending; maintenance (fail closed) and
 * the live state are re-checked before the wallet is asked.
 */
export async function signKycRegistryCreation(
  rpc: Rpc,
  e: KycRegistryCreationEnvelope,
  signer: TransactionSigner,
  opts: PinOption = {},
): Promise<KycRegistryCreationEnvelope> {
  if (signer.address !== e.kycAuthority && signer.address !== e.adminAuthority) {
    throw new Error("Connect the KYC authority or the Admin co-signer named in the document");
  }
  if (!isTransactionPartialSigner(signer)) {
    throw new Error("This wallet must support signing without sending to collect both approvals");
  }
  // Sent outside the verified client: the maintenance check fails closed.
  await assertSiteWritable({ failClosed: true });
  const pinned = opts.pinned !== undefined ? opts.pinned : configuredKycRegistry();
  await assertCreationLive(rpc, e, pinned);
  const transaction = await compileKycRegistryCreation(e);
  const signed = await signer.signTransactions([transaction]);
  const sig = signed[0]?.[signer.address];
  if (!sig) throw new Error("The wallet did not return its signature");
  const next: KycRegistryCreationEnvelope = {
    ...e,
    signatures: { ...e.signatures, [signer.address]: getBase58Decoder().decode(sig) },
  };
  await compileKycRegistryCreation(next);
  return next;
}

/** True once every required signature is present (one when both roles are one key). */
export function kycRegistryCreationSigned(e: KycRegistryCreationEnvelope): boolean {
  return [e.kycAuthority, e.adminAuthority].every((key) => !!e.signatures[key]);
}

/**
 * Sends the fully signed transaction after the maintenance check (fail
 * closed), the live checks, a full-signature check and a fresh network
 * check. The caller then waits for the registry (waitForKycRegistry), drops
 * the KYC and role caches and records the audit breadcrumb.
 */
export async function submitKycRegistryCreation(
  rpc: Rpc,
  e: KycRegistryCreationEnvelope,
  opts: PinOption = {},
): Promise<string> {
  await assertSiteWritable({ failClosed: true });
  const pinned = opts.pinned !== undefined ? opts.pinned : configuredKycRegistry();
  await assertCreationLive(rpc, e, pinned);
  const transaction = await compileKycRegistryCreation(e);
  assertIsFullySignedTransaction(transaction);
  await createNetworkVerifier(rpc, e.network)();
  return rpc
    .sendTransaction(getBase64EncodedWireTransaction(transaction), {
      encoding: "base64",
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: BigInt(3),
    })
    .send({ abortSignal: AbortSignal.timeout(20_000) });
}
