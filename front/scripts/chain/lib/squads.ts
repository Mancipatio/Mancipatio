/**
 * Squads v4 helpers (design-3.3 §6.10, §7): program id, vault PDA, the
 * `Multisig` decoder, the map comparison, the `Proposal` decoder and the
 * open-proposal scan, the only-vault-signer guard, the vault-transaction
 * encoder and the external-transaction inspector with the verify
 * build-argument check.
 *
 * EXTERNAL #4 (closed by the 6.1 rehearsal): the `Multisig` layout is the v4
 * struct (create_key, config_authority, threshold u16, time_lock u32,
 * transaction_index u64, stale_transaction_index u64, rent_collector
 * Option<Pubkey>, bump u8, members Vec<(key, permissions mask u8)>). The
 * account is sized for Some(rent_collector), so without one it ends in 32
 * unused zero bytes; Squads stores the members sorted by key. The test
 * fixture is a real account created on a local validator by the mainnet
 * Squads v4 program.
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
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  decodeComputeBudgetInstruction,
  type DecodedComputeBudget,
} from "@/lib/compute-budget";
import { SYSTEM_PROGRAM, programDataAddress } from "./loader-v3";
import type { LatestBlockhash } from "./tx";

export const SQUADS_V4_PROGRAM = address("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
/** The OtterSec verify program (solana-verify's PDA uploads; seen on mainnet and cloned in the 6.1 rehearsal). */
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

// ── Proposals ────────────────────────────────────────────────────────────────

export const PROPOSAL_DISCRIMINATOR = new Uint8Array(
  createHash("sha256").update("account:Proposal").digest().subarray(0, 8),
);

/** v4 `ProposalStatus` variants in their Borsh order; only `Executing` has no timestamp. */
export const PROPOSAL_STATUSES = ["Draft", "Active", "Rejected", "Approved", "Executing", "Executed", "Cancelled"] as const;
export type ProposalStatusName = (typeof PROPOSAL_STATUSES)[number];
/** A proposal in one of these states can never execute. */
export const FINAL_PROPOSAL_STATUSES: readonly ProposalStatusName[] = ["Rejected", "Executed", "Cancelled"];

/** ["multisig", multisig, "transaction", index u64 LE, "proposal"] under the Squads program. */
export async function squadsProposalPda(multisig: Address, transactionIndex: bigint): Promise<Address> {
  const utf8 = getUtf8Encoder();
  const index = new Uint8Array(8);
  new DataView(index.buffer).setBigUint64(0, transactionIndex, true);
  const [pda] = await getProgramDerivedAddress({
    programAddress: SQUADS_V4_PROGRAM,
    seeds: [utf8.encode("multisig"), addressEncoder.encode(multisig), utf8.encode("transaction"), index, utf8.encode("proposal")],
  });
  return pda;
}

export type DecodedProposal = {
  multisig: Address;
  transactionIndex: bigint;
  status: ProposalStatusName;
  approved: Address[];
  rejected: Address[];
  cancelled: Address[];
};

/** Decodes a v4 `Proposal` account. Throws on any layout violation. */
export function decodeProposal(data: Uint8Array): DecodedProposal {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  const take = (n: number) => {
    if (offset + n > data.length) throw new Error("Proposal account truncated");
    const slice = data.subarray(offset, offset + n);
    offset += n;
    return slice;
  };
  if (!Buffer.from(take(8)).equals(Buffer.from(PROPOSAL_DISCRIMINATOR))) throw new Error("Not a Squads v4 Proposal account");
  const multisig = addressDecoder.decode(take(32));
  take(8);
  const transactionIndex = view.getBigUint64(offset - 8, true);
  const variant = take(1)[0];
  const status = PROPOSAL_STATUSES[variant];
  if (!status) throw new Error("Unknown proposal status");
  if (status !== "Executing") take(8);
  take(1); // bump
  const keys = () => {
    take(4);
    const count = view.getUint32(offset - 4, true);
    if (count > 65_535) throw new Error("Implausible proposal vote count");
    return Array.from({ length: count }, () => addressDecoder.decode(take(32)));
  };
  const approved = keys();
  const rejected = keys();
  const cancelled = keys();
  return { multisig, transactionIndex, status, approved, rejected, cancelled };
}

/** Encodes a v4 `Proposal` (tests only). */
export function encodeProposal(value: DecodedProposal & { timestamp?: bigint; bump?: number }): Uint8Array {
  const u64 = (n: bigint) => {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, n, true);
    return out;
  };
  const vec = (keys: Address[]) => {
    const count = new Uint8Array(4);
    new DataView(count.buffer).setUint32(0, keys.length, true);
    return [count, ...keys.map((k) => new Uint8Array(addressEncoder.encode(k)))];
  };
  const variant = PROPOSAL_STATUSES.indexOf(value.status);
  const parts: Uint8Array[] = [
    PROPOSAL_DISCRIMINATOR,
    new Uint8Array(addressEncoder.encode(value.multisig)),
    u64(value.transactionIndex),
    Uint8Array.of(variant),
    ...(value.status === "Executing" ? [] : [u64(value.timestamp ?? BigInt(0))]),
    Uint8Array.of(value.bump ?? 255),
    ...vec(value.approved),
    ...vec(value.rejected),
    ...vec(value.cancelled),
  ];
  return Uint8Array.from(Buffer.concat(parts));
}

/** The most recent transaction indexes `chain:inventory` reads proposals for. */
export const MAX_PROPOSAL_SCAN = 1000;

export type OpenProposal = {
  transactionIndex: string;
  proposal: Address;
  status: ProposalStatusName;
  approvals: number;
  /** index ≤ stale_transaction_index: it can no longer be approved (an Approved vault transaction still executes). */
  stale: boolean;
};

export type ProposalScan = {
  /** Transaction indexes read (from max(1, transactionIndex − MAX_PROPOSAL_SCAN + 1)). */
  fromIndex: string;
  toIndex: string;
  /** Proposals that can still become or are executable: Draft, Active, Approved, Executing. */
  open: OpenProposal[];
  errors: string[];
};

/**
 * Reads the Proposal accounts of the multisig's transaction indexes and
 * returns the ones that are not final. A proposal whose execution failed
 * stays Approved and any member with Execute can run it later, so it must be
 * cancelled (runbook §9). A missing Proposal account is skipped: it was never
 * proposed or its accounts were closed after it finished.
 */
export async function scanOpenProposals(
  multisig: Address,
  decoded: DecodedMultisig,
  fetch: (addresses: Address[]) => Promise<Map<Address, { owner: Address; data: Uint8Array } | null>>,
): Promise<ProposalScan> {
  const last = decoded.transactionIndex;
  const window = BigInt(MAX_PROPOSAL_SCAN);
  const first = last >= window ? last - window + BigInt(1) : BigInt(1);
  const scan: ProposalScan = { fromIndex: first.toString(), toIndex: last.toString(), open: [], errors: [] };
  if (last < BigInt(1)) return scan;
  const pdas: { index: bigint; pda: Address }[] = [];
  for (let index = first; index <= last; index++) pdas.push({ index, pda: await squadsProposalPda(multisig, index) });
  const accounts = await fetch(pdas.map((p) => p.pda));
  for (const { index, pda } of pdas) {
    const account = accounts.get(pda);
    if (!account) continue;
    let proposal: DecodedProposal;
    try {
      if (account.owner !== SQUADS_V4_PROGRAM) throw new Error("owner is not the Squads v4 program");
      proposal = decodeProposal(account.data);
      if (proposal.multisig !== multisig || proposal.transactionIndex !== index) throw new Error("multisig or index mismatch");
    } catch (error) {
      scan.errors.push(`proposal #${index} ${pda}: ${(error as Error).message}`);
      continue;
    }
    if (FINAL_PROPOSAL_STATUSES.includes(proposal.status)) continue;
    scan.open.push({
      transactionIndex: index.toString(),
      proposal: pda,
      status: proposal.status,
      approvals: proposal.approved.length,
      stale: index <= decoded.staleTransactionIndex,
    });
  }
  return scan;
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

/** Upper bound of the System transfers into the verify PDA (its rent), in total. */
export const MAX_EXTERNAL_TRANSFER_LAMPORTS = BigInt(50_000_000);

/**
 * The OtterSec verify PDA of `program` uploaded by `uploader`, seeds
 * ["otter_verify", uploader, program] under OTTERSEC_VERIFY_PROGRAM (the
 * `build_params` account of initialize/update/close). The 6.1 rehearsal
 * matched it against `solana-verify export-pda-tx` 0.5.1 output.
 */
export async function otterVerifyPda(uploader: Address, program: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: OTTERSEC_VERIFY_PROGRAM,
    seeds: [getUtf8Encoder().encode("otter_verify"), addressEncoder.encode(uploader), addressEncoder.encode(program)],
  });
  return pda;
}

/**
 * otter-verify instruction discriminators, as `solana-verify` 0.5.1 builds
 * them (`OtterVerifyInstructions`): initialize and update carry
 * `InputParams`, close carries nothing.
 */
export const OTTER_VERIFY_IX = {
  initialize: Uint8Array.of(175, 175, 109, 31, 13, 152, 155, 237),
  update: Uint8Array.of(219, 200, 88, 176, 158, 63, 253, 127),
  close: Uint8Array.of(98, 165, 201, 177, 108, 65, 206, 96),
} as const;

/** `InputParams { version, git_url, commit, args: Vec<String>, deployed_slot: u64 }` (Borsh). */
export type VerifyParams = {
  version: string;
  gitUrl: string;
  commit: string;
  args: string[];
  deployedSlot: bigint;
};

export type DecodedVerifyInstruction = { kind: "initialize" | "update"; params: VerifyParams } | { kind: "close" };

/** Decodes an otter-verify instruction's data. Throws on an unknown instruction or any trailing byte. */
export function decodeVerifyInstructionData(data: Uint8Array): DecodedVerifyInstruction {
  const disc = data.subarray(0, 8);
  const is = (expected: Uint8Array) => disc.length === 8 && Buffer.from(disc).equals(Buffer.from(expected));
  if (is(OTTER_VERIFY_IX.close)) {
    if (data.length !== 8) throw new Error("A verify close instruction carries unexpected data");
    return { kind: "close" };
  }
  const kind = is(OTTER_VERIFY_IX.initialize) ? "initialize" : is(OTTER_VERIFY_IX.update) ? "update" : null;
  if (!kind) throw new Error("A verify instruction is not initialize, update or close (solana-verify export-pda-tx)");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 8;
  const u32 = () => {
    if (offset + 4 > data.length) throw new Error("Verify instruction data truncated");
    offset += 4;
    return view.getUint32(offset - 4, true);
  };
  const text = () => {
    const length = u32();
    if (offset + length > data.length) throw new Error("Verify instruction data truncated");
    const value = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(offset, offset + length));
    offset += length;
    return value;
  };
  const version = text();
  const gitUrl = text();
  const commit = text();
  const count = u32();
  if (count > 64) throw new Error("Implausible verify argument count");
  const args = Array.from({ length: count }, text);
  if (offset + 8 > data.length) throw new Error("Verify instruction data truncated");
  const deployedSlot = view.getBigUint64(offset, true);
  offset += 8;
  if (offset !== data.length) throw new Error("Verify instruction data has trailing bytes");
  return { kind, params: { version, gitUrl, commit, args, deployedSlot } };
}

/** Encodes initialize/update data (tests only). */
export function encodeVerifyInstructionData(kind: "initialize" | "update", params: VerifyParams): Uint8Array {
  const utf8 = new TextEncoder();
  const u32 = (n: number) => {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, n, true);
    return out;
  };
  const text = (value: string) => {
    const bytes = utf8.encode(value);
    return [u32(bytes.length), bytes];
  };
  const slot = new Uint8Array(8);
  new DataView(slot.buffer).setBigUint64(0, params.deployedSlot, true);
  return Uint8Array.from(
    Buffer.concat([
      OTTER_VERIFY_IX[kind],
      ...text(params.version),
      ...text(params.gitUrl),
      ...text(params.commit),
      u32(params.args.length),
      ...params.args.flatMap(text),
      slot,
    ]),
  );
}

/** The monorepo keeps the programs under program/ (verifiable-build.yml). */
export const VERIFY_MOUNT_PATH = "program";
const VERIFY_VALUE_FLAGS = new Set(["--mount-path", "--library-name", "--base-image", "--arch"]);
const VERIFY_ARCHES = new Set(["v0", "v1", "v2", "v3"]);

/**
 * Problems with the build arguments a verify PDA would store. OtterSec's
 * remote build re-runs `solana-verify build` with exactly these arguments;
 * without `--base-image` it infers an image from Cargo.lock, which for this
 * workspace is not the Release's image (solana-program-error 3.0.1 ⇒ the
 * 3.0.1 image, while the Release is built with 3.1.13), so the hash would not
 * reproduce. Only the flags the Release build uses are accepted.
 */
export function verifyParamProblems(
  params: VerifyParams,
  expected: { libraryName: string; commit: string | null; baseImage: string | null },
): string[] {
  const problems: string[] = [];
  const values = new Map<string, string>();
  for (let i = 0; i < params.args.length; i++) {
    const flag = params.args[i];
    if (!VERIFY_VALUE_FLAGS.has(flag)) {
      problems.push(`unexpected build argument ${JSON.stringify(flag)} (only --mount-path, --library-name, --base-image, --arch)`);
      continue;
    }
    const value = params.args[i + 1];
    if (value === undefined || VERIFY_VALUE_FLAGS.has(value)) {
      problems.push(`${flag} has no value`);
      continue;
    }
    if (values.has(flag)) problems.push(`${flag} is given twice`);
    values.set(flag, value);
    i++;
  }
  if (values.get("--mount-path") !== VERIFY_MOUNT_PATH) {
    problems.push(`--mount-path is ${values.get("--mount-path") ?? "missing"}, not ${VERIFY_MOUNT_PATH}`);
  }
  if (values.get("--library-name") !== expected.libraryName) {
    problems.push(`--library-name is ${values.get("--library-name") ?? "missing"}, not ${expected.libraryName}`);
  }
  const baseImage = values.get("--base-image");
  if (!baseImage) problems.push("--base-image is missing (the remote build would infer another image from Cargo.lock)");
  else if (expected.baseImage && baseImage !== expected.baseImage) {
    problems.push(`--base-image is ${baseImage}, not the Release's ${expected.baseImage}`);
  }
  const arch = values.get("--arch");
  if (arch !== undefined && !VERIFY_ARCHES.has(arch)) problems.push(`--arch ${arch} is not v0..v3`);
  if (!/^[0-9a-f]{40}$/.test(params.commit)) problems.push(`commit ${JSON.stringify(params.commit)} is not a full 40-hex commit`);
  else if (expected.commit && params.commit !== expected.commit) {
    problems.push(`commit ${params.commit} is not the Release commit ${expected.commit}`);
  }
  return problems;
}

export type ExternalVerification = {
  /** The one program of ours the instruction references. */
  program: Address;
  pda: Address;
} & DecodedVerifyInstruction;

export type ExternalInspection = {
  /** The instructions the vault transaction carries (ComputeBudget ones removed). */
  instructions: Instruction[];
  /** One decoded entry per verify instruction, in order. */
  verifications: ExternalVerification[];
  /**
   * Top-level ComputeBudget SetComputeUnitLimit / SetComputeUnitPrice
   * instructions of the external transaction, removed from `instructions`:
   * inside a vault transaction they would only be a no-op CPI (the member who
   * executes sets the real price). `solana-verify export-pda-tx` adds a
   * SetComputeUnitPrice by default (`--compute-unit-price`, 100000; the 6.1
   * rehearsal saw it).
   */
  droppedComputeBudget: DecodedComputeBudget[];
  /** Our program IDs the verify instructions reference. */
  programs: Address[];
  /** The verify PDA of each referenced program, uploader = the vault. */
  pdas: { program: Address; pda: Address }[];
  /** System transfers from the vault into a verify PDA. */
  transfers: { destination: Address; program: Address; lamports: bigint }[];
};

const SYSTEM_TRANSFER_TAG = 2;

/**
 * Decodes an external transaction (EXTERNAL #5: `solana-verify
 * export-pda-tx`). The vault must be the fee payer and the only signer. Every
 * instruction is either
 * - an OtterSec verify instruction that the vault signs, that references
 *   exactly one of `programs` (our program IDs), that carries its verify PDA
 *   (`otterVerifyPda(vault, program)`), whose accounts are only that closed
 *   set: the vault, the referenced program ID, its verify PDA, its
 *   ProgramData and the System program, and whose data is an initialize,
 *   update or close as solana-verify builds them (decoded into
 *   `verifications`; the caller checks the build arguments); or
 * - a System `Transfer` from the vault into the derived verify PDA of a
 *   referenced program; all transfers together at most
 *   MAX_EXTERNAL_TRANSFER_LAMPORTS; or
 * - a ComputeBudget SetComputeUnitLimit / SetComputeUnitPrice without
 *   accounts, which is dropped from the vault transaction and reported
 *   (`droppedComputeBudget`); any other ComputeBudget instruction is refused.
 * Any other System instruction (a transfer elsewhere, assign, allocate, …) is
 * refused: the vault is also the protocol treasury (D5). Account roles in a
 * compiled message are message-wide, so a destination is never accepted for
 * being "writable in a verify instruction": only the derived PDA is.
 */
export async function inspectExternalTransaction(
  base58: string,
  vault: Address,
  programs: readonly Address[],
): Promise<ExternalInspection> {
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
  const decompiled = ([...message.instructions] as Instruction[]).map((ix) => ({
    programAddress: ix.programAddress,
    accounts: (ix.accounts ?? []).map((meta) => ({ address: meta.address, role: meta.role })),
    data: ix.data ? new Uint8Array(ix.data) : new Uint8Array(),
  }));
  // ComputeBudget: only SetComputeUnitLimit / SetComputeUnitPrice without
  // accounts, and they are dropped (a no-op inside a vault transaction).
  const droppedComputeBudget: DecodedComputeBudget[] = [];
  const instructions = decompiled.filter((ix) => {
    if (ix.programAddress !== COMPUTE_BUDGET_PROGRAM_ADDRESS) return true;
    const decoded = decodeComputeBudgetInstruction(ix);
    if (!decoded || ix.accounts.length) {
      throw new Error("The external transaction has a ComputeBudget instruction other than SetComputeUnitLimit or SetComputeUnitPrice");
    }
    droppedComputeBudget.push(decoded);
    return false;
  });
  for (const ix of instructions) {
    if (ix.programAddress !== OTTERSEC_VERIFY_PROGRAM && ix.programAddress !== SYSTEM_PROGRAM) {
      throw new Error(`The external transaction calls ${ix.programAddress}; only the verify and System programs are allowed`);
    }
  }
  const verify = instructions.filter((ix) => ix.programAddress === OTTERSEC_VERIFY_PROGRAM);
  if (!verify.length) throw new Error("The external transaction has no verify instruction");
  const ours = new Set<string>(programs);
  const derived = new Map<Address, { pda: Address; programData: Address }>();
  for (const program of programs) {
    derived.set(program, { pda: await otterVerifyPda(vault, program), programData: await programDataAddress(program) });
  }
  const referenced = new Set<Address>();
  /** verify PDA → the program it belongs to (only PDAs a verify instruction carries). */
  const pdaOf = new Map<Address, Address>();
  const verifications: ExternalVerification[] = [];
  for (const ix of verify) {
    if (!ix.accounts.some((meta) => meta.address === vault && isSignerRole(meta.role))) {
      throw new Error("A verify instruction does not name the vault as its signer (uploader)");
    }
    const mine = [...new Set(ix.accounts.filter((meta) => ours.has(meta.address)).map((meta) => meta.address))];
    if (!mine.length) throw new Error("A verify instruction references none of our program IDs");
    if (mine.length > 1) throw new Error("A verify instruction references more than one of our program IDs");
    const allowed = new Set<Address>([vault, SYSTEM_PROGRAM]);
    for (const program of mine) {
      const { pda, programData } = derived.get(program)!;
      allowed.add(program);
      allowed.add(pda);
      allowed.add(programData);
    }
    for (const meta of ix.accounts) {
      if (!allowed.has(meta.address)) {
        throw new Error(
          `A verify instruction has the account ${meta.address}, which is not the vault, a referenced program, its verify PDA, its ProgramData or System`,
        );
      }
    }
    const carried = mine.filter((program) => ix.accounts.some((meta) => meta.address === derived.get(program)!.pda));
    if (!carried.length) {
      throw new Error("A verify instruction does not carry the verify PDA (\"otter_verify\", vault, program) of a program it references");
    }
    for (const program of mine) referenced.add(program);
    for (const program of carried) pdaOf.set(derived.get(program)!.pda, program);
    verifications.push({ program: mine[0], pda: derived.get(mine[0])!.pda, ...decodeVerifyInstructionData(ix.data) });
  }
  const transfers: ExternalInspection["transfers"] = [];
  let total = BigInt(0);
  for (const ix of instructions) {
    if (ix.programAddress !== SYSTEM_PROGRAM) continue;
    const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
    const isTransfer = ix.data.length === 12 && view.getUint32(0, true) === SYSTEM_TRANSFER_TAG && ix.accounts.length === 2;
    if (!isTransfer) throw new Error("The external transaction has a System instruction other than a transfer into the verify PDA");
    const [source, destination] = ix.accounts;
    const lamports = view.getBigUint64(4, true);
    const program = pdaOf.get(destination.address);
    if (source.address !== vault || !program) {
      throw new Error(
        `The external transaction transfers lamports from ${source.address} to ${destination.address}; only a transfer from the vault into the derived verify PDA is allowed`,
      );
    }
    total += lamports;
    if (total > MAX_EXTERNAL_TRANSFER_LAMPORTS) {
      throw new Error(`The external transaction transfers ${total} lamports; at most ${MAX_EXTERNAL_TRANSFER_LAMPORTS} are allowed`);
    }
    transfers.push({ destination: destination.address, program, lamports });
  }
  const programsOut = [...referenced];
  return {
    instructions,
    verifications,
    droppedComputeBudget,
    programs: programsOut,
    pdas: programsOut.map((program) => ({ program, pda: derived.get(program)!.pda })),
    transfers,
  };
}
