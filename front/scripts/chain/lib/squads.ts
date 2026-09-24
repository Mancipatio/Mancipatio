/**
 * Squads v4 helpers (design-3.3 §6.10, §7): program id, vault PDA, the
 * `Multisig` decoder, the map comparison, the only-vault-signer guard, the
 * vault-transaction encoder and the external-transaction inspector.
 *
 * EXTERNAL #4: the `Multisig` layout is taken from the v4 struct
 * (create_key, config_authority, threshold u16, time_lock u32,
 * transaction_index u64, stale_transaction_index u64, rent_collector
 * Option<Pubkey>, bump u8, members Vec<(key, permissions mask u8)>). The 6.1
 * rehearsal replaces the synthesized fixture with a real account dump.
 */
import { createHash } from "node:crypto";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  decompileTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  getBase58Encoder,
  getBase64Decoder,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
  getTransactionEncoder,
  getUtf8Encoder,
  isSignerRole,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
} from "@solana/kit";
import { SYSTEM_PROGRAM } from "./loader-v3";
import type { LatestBlockhash } from "./tx";

export const SQUADS_V4_PROGRAM = address("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
/** EXTERNAL #5: the OtterSec verify program (solana-verify's PDA uploads). */
export const OTTERSEC_VERIFY_PROGRAM = address("verifycLy8mB96wd9wqq3WDXQwM4oU6r42Th37Db9fC");
export const DEFAULT_PUBKEY = address("11111111111111111111111111111111");
/** EXTERNAL #1: the inner vault-message budget; bigger exports are split. */
export const SQUADS_INNER_MESSAGE_BUDGET = 800;

export const Permission = { initiate: 1, vote: 2, execute: 4 } as const;
export type PermissionName = keyof typeof Permission;
export const PERMISSION_NAMES: PermissionName[] = ["initiate", "vote", "execute"];

export const MULTISIG_DISCRIMINATOR = new Uint8Array(
  createHash("sha256").update("account:Multisig").digest().subarray(0, 8),
);

const addressEncoder = getAddressEncoder();
const addressDecoder = getAddressDecoder();

export async function squadsVaultPda(multisig: Address, index: number): Promise<Address> {
  if (!Number.isInteger(index) || index < 0 || index > 255) throw new Error("vault index must be a u8");
  const utf8 = getUtf8Encoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: SQUADS_V4_PROGRAM,
    seeds: [utf8.encode("multisig"), addressEncoder.encode(multisig), utf8.encode("vault"), Uint8Array.of(index)],
  });
  return pda;
}

export type MultisigMember = { key: Address; mask: number; permissions: PermissionName[] };
export type DecodedMultisig = {
  createKey: Address;
  /** null when the on-chain value is the default key (autonomous multisig). */
  configAuthority: Address | null;
  threshold: number;
  timeLock: number;
  transactionIndex: bigint;
  staleTransactionIndex: bigint;
  rentCollector: Address | null;
  bump: number;
  members: MultisigMember[];
};

export function permissionsFromMask(mask: number): PermissionName[] {
  return PERMISSION_NAMES.filter((name) => (mask & Permission[name]) !== 0);
}

export function maskFromPermissions(names: readonly string[]): number {
  return names.reduce((mask, name) => mask | (Permission[name as PermissionName] ?? 0), 0);
}

/** Decodes a v4 `Multisig` account. Throws on any layout violation. */
export function decodeMultisig(data: Uint8Array): DecodedMultisig {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  const take = (n: number) => {
    if (offset + n > data.length) throw new Error("Multisig account truncated");
    const slice = data.subarray(offset, offset + n);
    offset += n;
    return slice;
  };
  const disc = take(8);
  if (!Buffer.from(disc).equals(Buffer.from(MULTISIG_DISCRIMINATOR))) throw new Error("Not a Squads v4 Multisig account");
  const createKey = addressDecoder.decode(take(32));
  const config = addressDecoder.decode(take(32));
  take(2);
  const threshold = view.getUint16(offset - 2, true);
  take(4);
  const timeLock = view.getUint32(offset - 4, true);
  take(8);
  const transactionIndex = view.getBigUint64(offset - 8, true);
  take(8);
  const staleTransactionIndex = view.getBigUint64(offset - 8, true);
  const rentTag = take(1)[0];
  if (rentTag > 1) throw new Error("Invalid rent_collector option");
  const rentCollector = rentTag === 1 ? addressDecoder.decode(take(32)) : null;
  const bump = take(1)[0];
  take(4);
  const count = view.getUint32(offset - 4, true);
  if (count > 65_535) throw new Error("Implausible member count");
  const members: MultisigMember[] = [];
  for (let i = 0; i < count; i++) {
    const key = addressDecoder.decode(take(32));
    const mask = take(1)[0];
    if (mask & ~7) throw new Error("Unknown permission bits");
    members.push({ key, mask, permissions: permissionsFromMask(mask) });
  }
  return {
    createKey,
    configAuthority: config === DEFAULT_PUBKEY ? null : config,
    threshold,
    timeLock,
    transactionIndex,
    staleTransactionIndex,
    rentCollector,
    bump,
    members,
  };
}

/** Encodes a v4 `Multisig` (fixture synthesis and tests only). */
export function encodeMultisig(value: Omit<DecodedMultisig, "members"> & { members: { key: Address; mask: number }[] }): Uint8Array {
  const parts: Uint8Array[] = [MULTISIG_DISCRIMINATOR, new Uint8Array(addressEncoder.encode(value.createKey))];
  parts.push(new Uint8Array(addressEncoder.encode(value.configAuthority ?? DEFAULT_PUBKEY)));
  const numbers = new Uint8Array(2 + 4 + 8 + 8);
  const view = new DataView(numbers.buffer);
  view.setUint16(0, value.threshold, true);
  view.setUint32(2, value.timeLock, true);
  view.setBigUint64(6, value.transactionIndex, true);
  view.setBigUint64(14, value.staleTransactionIndex, true);
  parts.push(numbers);
  parts.push(value.rentCollector ? Uint8Array.of(1, ...addressEncoder.encode(value.rentCollector)) : Uint8Array.of(0));
  parts.push(Uint8Array.of(value.bump));
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, value.members.length, true);
  parts.push(count);
  for (const member of value.members) parts.push(Uint8Array.of(...addressEncoder.encode(member.key), member.mask));
  return Uint8Array.from(Buffer.concat(parts));
}

export type SquadsMapConfig = {
  multisig: Address;
  vaultIndex: number;
  vault: Address;
  threshold: number;
  timeLock: number;
  configAuthority: Address | null;
  members: { key: Address; permissions: string[] }[];
};

/** Exact comparison with the role map (design §4.4, §6.10): mismatch texts. */
export function compareMultisig(decoded: DecodedMultisig, expected: SquadsMapConfig): string[] {
  const out: string[] = [];
  if (decoded.threshold !== expected.threshold) out.push(`threshold ${decoded.threshold} ≠ map ${expected.threshold}`);
  if (decoded.timeLock !== expected.timeLock) out.push(`time_lock ${decoded.timeLock} ≠ map ${expected.timeLock}`);
  if (decoded.configAuthority !== expected.configAuthority) {
    out.push(`config_authority ${decoded.configAuthority ?? "none"} ≠ map ${expected.configAuthority ?? "none"}`);
  }
  const onChain = new Map(decoded.members.map((m) => [m.key, m.mask]));
  const inMap = new Map(expected.members.map((m) => [m.key, maskFromPermissions(m.permissions)]));
  for (const [key, mask] of inMap) {
    if (!onChain.has(key)) out.push(`member ${key} missing on-chain`);
    else if (onChain.get(key) !== mask) {
      out.push(`member ${key} permissions ${permissionsFromMask(onChain.get(key)!).join("+")} ≠ map ${permissionsFromMask(mask).join("+")}`);
    }
  }
  for (const key of onChain.keys()) if (!inMap.has(key)) out.push(`member ${key} on-chain but not in the map`);
  return out;
}

export type SquadsCheck = {
  ok: boolean;
  owner: string | null;
  vaultDerivationOk: boolean;
  decoded: DecodedMultisig | null;
  errors: string[];
};

/** Owner, vault derivation, decode and the exact map comparison. */
export async function checkSquadsAccount(
  account: { owner: Address; data: Uint8Array } | null,
  expected: SquadsMapConfig,
): Promise<SquadsCheck> {
  const errors: string[] = [];
  const vaultDerivationOk = (await squadsVaultPda(expected.multisig, expected.vaultIndex)) === expected.vault;
  if (!vaultDerivationOk) errors.push("vault is not PDA(multisig, vaultIndex)");
  if (!account) return { ok: false, owner: null, vaultDerivationOk, decoded: null, errors: [...errors, "multisig account not found"] };
  if (account.owner !== SQUADS_V4_PROGRAM) errors.push(`multisig owner ${account.owner} is not the Squads v4 program`);
  let decoded: DecodedMultisig | null = null;
  try {
    decoded = decodeMultisig(account.data);
  } catch (error) {
    errors.push(`multisig decode failed: ${(error as Error).message}`);
  }
  if (decoded) errors.push(...compareMultisig(decoded, expected));
  return { ok: errors.length === 0, owner: account.owner, vaultDerivationOk, decoded, errors };
}

// ── Vault transactions ───────────────────────────────────────────────────────

/** Only the vault may sign any instruction of an export. */
export function assertOnlyVaultSigner(ixs: Instruction[], vault: Address): void {
  for (const ix of ixs) {
    for (const meta of ix.accounts ?? []) {
      if (isSignerRole(meta.role) && meta.address !== vault) {
        throw new Error(`Only the Squads vault may sign; ${meta.address} is a signer`);
      }
    }
  }
}

export type EncodedVaultTransaction = {
  messageBytes: number;
  transactionBase58: string;
  transactionBase64: string;
};

/** An unsigned legacy transaction with the vault as fee payer. */
export function encodeVaultTransaction(input: {
  vault: Address;
  ixs: Instruction[];
  blockhash: LatestBlockhash;
}): EncodedVaultTransaction {
  assertOnlyVaultSigner(input.ixs, input.vault);
  const message = pipe(
    createTransactionMessage({ version: "legacy" }),
    (m) => setTransactionMessageFeePayer(input.vault, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(input.blockhash, m),
    (m) => appendTransactionMessageInstructions(input.ixs, m),
  );
  const compiled = compileTransaction(message);
  const signers = Object.keys(compiled.signatures);
  if (signers.length !== 1 || signers[0] !== input.vault) throw new Error("The vault must be the only signer");
  const wire = getTransactionEncoder().encode(compiled);
  return {
    messageBytes: compiled.messageBytes.length,
    transactionBase58: getBase58Decoder().decode(wire),
    transactionBase64: getBase64Decoder().decode(wire),
  };
}

export function describeInstruction(ix: Instruction) {
  const data = new Uint8Array(ix.data ?? new Uint8Array());
  return {
    program: ix.programAddress,
    accounts: (ix.accounts ?? []).map((meta) => ({
      address: meta.address,
      writable: meta.role === AccountRole.WRITABLE || meta.role === AccountRole.WRITABLE_SIGNER,
      signer: isSignerRole(meta.role),
    })),
    dataBase58: getBase58Decoder().decode(data),
    dataBase64: getBase64Decoder().decode(data),
  };
}

/**
 * Groups instructions (kept in order) into vault transactions whose compiled
 * message stays within the inner budget. Throws when one instruction alone
 * does not fit.
 */
export function splitBySize(
  ixs: Instruction[],
  vault: Address,
  blockhash: LatestBlockhash,
  budget = SQUADS_INNER_MESSAGE_BUDGET,
): Instruction[][] {
  const groups: Instruction[][] = [];
  let current: Instruction[] = [];
  for (const ix of ixs) {
    const candidate = [...current, ix];
    if (encodeVaultTransaction({ vault, ixs: candidate, blockhash }).messageBytes <= budget) {
      current = candidate;
      continue;
    }
    if (!current.length) throw new Error("One instruction exceeds the Squads inner message budget");
    groups.push(current);
    current = [ix];
    if (encodeVaultTransaction({ vault, ixs: current, blockhash }).messageBytes > budget) {
      throw new Error("One instruction exceeds the Squads inner message budget");
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

/**
 * Decodes an external transaction (EXTERNAL #5: `solana-verify
 * export-pda-tx`). Only the OtterSec verify program and the System program
 * may appear, and the vault must be the fee payer and the only signer.
 */
export function inspectExternalTransaction(base58: string, vault: Address): Instruction[] {
  let messageBytes: Uint8Array;
  try {
    messageBytes = new Uint8Array(getTransactionDecoder().decode(getBase58Encoder().encode(base58.trim())).messageBytes);
  } catch {
    throw new Error("The external transaction is not a base58 wire transaction");
  }
  const compiled = getCompiledTransactionMessageDecoder().decode(messageBytes);
  if ("addressTableLookups" in compiled && compiled.addressTableLookups?.length) {
    throw new Error("The external transaction uses address lookup tables");
  }
  const signerCount = compiled.header.numSignerAccounts;
  const signers = compiled.staticAccounts.slice(0, signerCount);
  if (signers.length !== 1 || signers[0] !== vault) {
    throw new Error("The external transaction must have the vault as its only signer and fee payer");
  }
  const message = decompileTransactionMessage(compiled);
  const instructions = [...message.instructions] as Instruction[];
  const allowed = new Set<string>([OTTERSEC_VERIFY_PROGRAM, SYSTEM_PROGRAM]);
  for (const ix of instructions) {
    if (!allowed.has(ix.programAddress)) {
      throw new Error(`The external transaction calls ${ix.programAddress}; only the verify and System programs are allowed`);
    }
  }
  return instructions.map((ix) => ({
    programAddress: ix.programAddress,
    accounts: (ix.accounts ?? []).map((meta) => ({ address: meta.address, role: meta.role })),
    data: ix.data ? new Uint8Array(ix.data) : new Uint8Array(),
  }));
}
