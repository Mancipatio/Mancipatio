// Issuer authority rotation, timelocked recovery and sale / payout-vault sync
// (program 2C-2). Pure helpers first (validation, state machines, the action
// matrix, countdowns, sync selection and bundling), then the chain readers and
// the instruction builders.
//
// The program enforces every rule itself. These helpers keep a wallet from
// signing a transaction that must fail, and show what a change does:
//
// * regular rotation: the current authority proposes, the new key accepts
//   (`AuthorityTransfer` at ["authority_transfer", issuer]);
// * recovery of a LOST key: the super admin proposes, the new key executes
//   inside [eta, expiresAt) (eta = proposal + 7 days, window 14 days); the
//   current authority or the super admin cancels; it goes stale when the
//   issuer authority or the super admin changes after the proposal;
// * sync: `Sale.authority` / `PayoutVault.founder` are snapshots of the
//   issuer authority. Anyone may copy the live authority into them; close,
//   vault and payout flows prepend the sync whenever it is out of date.
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  fetchEncodedAccount,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  getProgramDerivedAddress,
  getTransactionMessageSize,
  isAddress,
  pipe,
  setTransactionMessageFeePayer,
  type Address,
  type Base58EncodedBytes,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import type { SolanaClient } from "@solana/client";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  fetchMaybeAuthorityTransfer,
  fetchMaybeIssuer,
  fetchMaybeIssuerRecovery,
  findAssetPda,
  findPlatformPda,
  findRecoveryPda,
  getAcceptIssuerAuthorityInstruction,
  getAssetDiscriminatorBytes,
  getAuthorityTransferDecoder,
  getAuthorityTransferDiscriminatorBytes,
  getCancelIssuerAuthorityTransferInstruction,
  getCancelIssuerRecoveryInstruction,
  getExecuteIssuerRecoveryInstruction,
  getIssuerDiscriminatorBytes,
  getIssuerRecoveryDecoder,
  getIssuerRecoveryDiscriminatorBytes,
  getProposeIssuerAuthorityInstruction,
  getProposeIssuerRecoveryInstruction,
  getShareClassDiscriminatorBytes,
  getSyncPayoutFounderInstruction,
  getSyncSaleAuthorityInstruction,
  SaleStatus,
  type AuthorityTransfer,
  type IssuerRecovery,
} from "@/lib/generated/asset_registry";
import type { NetworkData } from "@/lib/enumerate";
import { findSalePda, findShareClassPda } from "@/lib/pdas";
import { findIssuerPermissionsAddress } from "@/lib/issuer-permissions";
import { DEFAULT_ADDRESS } from "@/lib/protocol-treasury";

type Rpc = SolanaClient["runtime"]["rpc"];

/** Mirrors the program's `ISSUER_RECOVERY_DELAY` (7 days). */
export const ISSUER_RECOVERY_DELAY_SECONDS = 604_800;
/** Mirrors the program's `ISSUER_RECOVERY_EXECUTION_WINDOW` (14 days after eta). */
export const ISSUER_RECOVERY_WINDOW_SECONDS = 1_209_600;
/**
 * `new_authority` sits at byte 72 of BOTH `AuthorityTransfer` and
 * `IssuerRecovery` (8-byte discriminator + two 32-byte keys), so one memcmp
 * finds every rotation or recovery staged for a wallet.
 */
export const NEW_AUTHORITY_OFFSET = 72;
/** Solana's packet limit for one transaction. */
export const TRANSACTION_SIZE_LIMIT = 1232;

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Why `candidate` cannot be proposed as the issuer's new authority, or null
 * when it can (an empty input is not an error yet). Mirrors
 * `validate_new_authority` (a valid, non-default key that is not the current
 * authority) and adds one app rule: the key must not already be ANOTHER
 * issuer's authority, because every issuer page resolves "my issuer" as the
 * single issuer whose authority is the connected wallet.
 */
export function proposedIssuerAuthorityError(
  candidate: string,
  currentAuthority: string | null | undefined,
  otherIssuerAuthorities: Iterable<string> = [],
): string | null {
  const value = candidate.trim();
  if (!value) return null;
  if (!isAddress(value)) return "Not a valid Solana address.";
  if (value === DEFAULT_ADDRESS) return "The default 1111…1111 address cannot be an authority.";
  if (currentAuthority && value === currentAuthority) return "This wallet is already the issuer authority.";
  for (const other of otherIssuerAuthorities) {
    if (other === value) {
      return "This wallet already controls another issuer. Use a wallet that is not an issuer authority yet.";
    }
  }
  return null;
}

// ── Regular transfer state ───────────────────────────────────────────────────

export type PendingIssuerTransfer = {
  target: string;
  currentAuthority: string;
  newAuthority: string;
  proposedBy: string;
};

export type IssuerTransferState =
  | { kind: "none" }
  /** Staged by the live authority: the named wallet can accept. */
  | { kind: "live"; newAuthority: string }
  /** Staged under a previous authority (a recovery moved it): accept fails; the live authority can cancel. */
  | { kind: "stale"; newAuthority: string };

/** Exactly the `accept_issuer_authority` constraint, read from chain data. */
export function issuerTransferState(
  issuerAddress: string,
  issuerAuthority: string,
  pending: PendingIssuerTransfer | null,
): IssuerTransferState {
  if (!pending || pending.target !== issuerAddress) return { kind: "none" };
  const live =
    pending.currentAuthority === issuerAuthority && pending.proposedBy === issuerAuthority;
  return live
    ? { kind: "live", newAuthority: pending.newAuthority }
    : { kind: "stale", newAuthority: pending.newAuthority };
}

// ── Recovery state ───────────────────────────────────────────────────────────

export type IssuerRecoveryRecord = {
  issuer: string;
  currentAuthority: string;
  newAuthority: string;
  proposedBy: string;
  proposedAt: number;
  eta: number;
  expiresAt: number;
};

export type IssuerRecoveryState =
  | { kind: "none" }
  /** Inside the timelock: `remaining` seconds until `eta`. */
  | { kind: "waiting"; newAuthority: string; proposedBy: string; eta: number; expiresAt: number; remaining: number }
  /** The new key can execute until `until` (`remaining` seconds left). */
  | { kind: "executable"; newAuthority: string; proposedBy: string; eta: number; until: number; remaining: number }
  /** The execution window has passed: only a cancel (or a re-proposal) helps. */
  | { kind: "expired"; newAuthority: string; proposedBy: string; expiresAt: number }
  /** The issuer authority changed after the proposal: execute fails, cancel works. */
  | { kind: "stale-authority"; newAuthority: string; proposedBy: string }
  /** The super admin changed after the proposal: execute fails, cancel works. */
  | { kind: "stale-admin"; newAuthority: string; proposedBy: string };

/**
 * The recovery exactly as `execute_issuer_recovery` judges it: bound to the
 * issuer's live authority and the live super admin, then `eta <= now <
 * expiresAt` (chain time, never the browser clock).
 */
export function issuerRecoveryState(
  recovery: IssuerRecoveryRecord | null,
  issuer: { address: string; authority: string },
  platformAdmin: string | null,
  chainNow: number,
): IssuerRecoveryState {
  if (!recovery || recovery.issuer !== issuer.address) return { kind: "none" };
  const base = { newAuthority: recovery.newAuthority, proposedBy: recovery.proposedBy };
  if (recovery.currentAuthority !== issuer.authority) return { kind: "stale-authority", ...base };
  if (platformAdmin !== null && recovery.proposedBy !== platformAdmin) return { kind: "stale-admin", ...base };
  if (chainNow < recovery.eta) {
    return { kind: "waiting", ...base, eta: recovery.eta, expiresAt: recovery.expiresAt, remaining: recovery.eta - chainNow };
  }
  if (chainNow < recovery.expiresAt) {
    return { kind: "executable", ...base, eta: recovery.eta, until: recovery.expiresAt, remaining: recovery.expiresAt - chainNow };
  }
  return { kind: "expired", ...base, expiresAt: recovery.expiresAt };
}

export type IssuerAuthorityActions = {
  /** Current authority: stage a regular rotation. */
  canPropose: boolean;
  /** Current authority: withdraw a staged rotation (live or stale). */
  canCancelTransfer: boolean;
  /** The staged new key of a live rotation. */
  canAccept: boolean;
  /** Super admin: propose a timelocked recovery. */
  canProposeRecovery: boolean;
  /** Current authority or super admin: cancel any recovery (live or stale). */
  canCancelRecovery: boolean;
  /** The recovery's new key, once executable. */
  canExecuteRecovery: boolean;
};

/** What the connected wallet may do, from on-chain state only. */
export function issuerAuthorityActions(
  wallet: string | null | undefined,
  ctx: {
    issuerAuthority: string;
    platformAdmin: string | null;
    transfer: IssuerTransferState;
    recovery: IssuerRecoveryState;
  },
): IssuerAuthorityActions {
  const w = wallet ?? null;
  const isAuthority = w !== null && w === ctx.issuerAuthority;
  const isSuperAdmin = w !== null && ctx.platformAdmin !== null && w === ctx.platformAdmin;
  return {
    canPropose: isAuthority,
    canCancelTransfer: isAuthority && ctx.transfer.kind !== "none",
    canAccept: w !== null && ctx.transfer.kind === "live" && ctx.transfer.newAuthority === w,
    canProposeRecovery: isSuperAdmin,
    canCancelRecovery: ctx.recovery.kind !== "none" && (isAuthority || isSuperAdmin),
    canExecuteRecovery:
      w !== null && ctx.recovery.kind === "executable" && ctx.recovery.newAuthority === w,
  };
}

/** "6d 23h 59m", "3h 02m", "4m 05s", "now". */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s === 0) return "now";
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${h}h ${pad(m)}m`;
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(sec)}s`;
  return `${sec}s`;
}

/** Unix seconds as "2026-09-30 14:05 UTC". */
export function formatUtc(unixSeconds: number): string {
  return `${new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// ── Sync selection and bundling ──────────────────────────────────────────────

export type SyncableSale = { address: Address; shareClass: Address; asset: Address; authority: Address };
export type SyncableVault = { address: Address; shareClass: Address; asset: Address; founder: Address };

/**
 * The `sync_sale_authority` / `sync_payout_founder` instructions for exactly
 * the sales and vaults whose snapshot differs from the live authority (a
 * synced one would be a no-op on-chain and only cost space).
 */
export function issuerSyncInstructions(params: {
  issuer: Address;
  issuerAuthority: Address;
  sales?: readonly SyncableSale[];
  vaults?: readonly SyncableVault[];
}): Instruction[] {
  const out: Instruction[] = [];
  for (const sale of params.sales ?? []) {
    if (sale.authority === params.issuerAuthority) continue;
    out.push(
      getSyncSaleAuthorityInstruction({
        sale: sale.address,
        shareClass: sale.shareClass,
        asset: sale.asset,
        issuer: params.issuer,
      }),
    );
  }
  for (const vault of params.vaults ?? []) {
    if (vault.founder === params.issuerAuthority) continue;
    out.push(
      getSyncPayoutFounderInstruction({
        vault: vault.address,
        shareClass: vault.shareClass,
        asset: vault.asset,
        issuer: params.issuer,
      }),
    );
  }
  return out;
}

/**
 * The payout vaults the issuer's CURRENT key works with: its own (`founder
 * == wallet`) and, with rotation on, every vault of its issuer's share
 * classes whose founder snapshot still names an older key. Those are flagged
 * `founderOutOfSync`: `post_update`, `release_payout` and
 * `claim_founder_yield` need a `sync_payout_founder` first.
 */
export function issuerVaultsFor<
  T extends { vault: { founder: Address | string; shareClass: Address | string } },
>(
  records: readonly T[],
  opts: {
    wallet: string;
    issuer: string | null;
    issuerOfShareClass: (shareClass: string) => string | undefined;
    rotation: boolean;
  },
): { record: T; founderOutOfSync: boolean }[] {
  const out: { record: T; founderOutOfSync: boolean }[] = [];
  for (const record of records) {
    const founder = record.vault.founder.toString();
    if (founder === opts.wallet) {
      out.push({ record, founderOutOfSync: false });
      continue;
    }
    if (!opts.rotation || !opts.issuer) continue;
    if (opts.issuerOfShareClass(record.vault.shareClass.toString()) === opts.issuer) {
      out.push({ record, founderOutOfSync: true });
    }
  }
  return out;
}

/**
 * The issuer's OPEN sales and every payout vault of its share classes, as
 * sync candidates (`issuerSyncInstructions` keeps the out-of-sync ones).
 * Closed sales are skipped: nothing reads their authority any more.
 */
export async function collectIssuerSyncTargets(
  data: Pick<NetworkData, "assets" | "shareClasses" | "legacyShareClasses" | "sales">,
  vaults: readonly { address: Address; vault: { shareClass: Address; founder: Address } }[],
  issuer: Address,
): Promise<{ sales: SyncableSale[]; vaults: SyncableVault[] }> {
  const assetOf = new Map<string, Address>();
  const classes = [...data.shareClasses, ...(data.legacyShareClasses ?? [])];
  for (const asset of data.assets) {
    if (asset.issuer !== issuer) continue;
    const [assetPda] = await findAssetPda({ issuer, assetId: asset.assetId });
    for (const sc of classes) {
      if (sc.asset !== assetPda) continue;
      assetOf.set(await findShareClassPda(assetPda, sc.classIndex), assetPda);
    }
  }
  const sales: SyncableSale[] = [];
  for (const sale of data.sales) {
    const asset = assetOf.get(sale.shareClass);
    if (!asset || sale.status !== SaleStatus.Open) continue;
    sales.push({
      address: await findSalePda(sale.shareClass, sale.saleId),
      shareClass: sale.shareClass,
      asset,
      authority: sale.authority,
    });
  }
  const out: SyncableVault[] = [];
  for (const record of vaults) {
    const asset = assetOf.get(record.vault.shareClass);
    if (!asset) continue;
    out.push({
      address: record.address,
      shareClass: record.vault.shareClass,
      asset,
      founder: record.vault.founder,
    });
  }
  return { sales, vaults: out };
}

/** One line for an operator or issuer: what the recovery state means now. */
export function describeRecoveryState(state: IssuerRecoveryState): string {
  switch (state.kind) {
    case "none":
      return "No recovery pending.";
    case "waiting":
      return `Waiting period: executable in ${formatCountdown(state.remaining)} (from ${formatUtc(state.eta)}).`;
    case "executable":
      return `Executable by the proposed wallet for ${formatCountdown(state.remaining)} more (until ${formatUtc(state.until)}).`;
    case "expired":
      return `Expired at ${formatUtc(state.expiresAt)}: it can no longer be executed. Cancel it, and propose again if still needed.`;
    case "stale-authority":
      return "Stale: the issuer key changed after this recovery was proposed, so it can no longer be executed. Cancel it to return the rent.";
    case "stale-admin":
      return "Stale: the Super Admin changed after this recovery was proposed, so it can no longer be executed. Cancel it to return the rent.";
  }
}

/** Serialized size of one transaction carrying `instructions` (all signatures included). */
export function transactionSize(feePayer: Address, instructions: readonly Instruction[]): number {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return getTransactionMessageSize(message);
}

/**
 * Splits `primary` + `syncs` into as few transactions as fit the packet
 * limit, keeping the order the program needs:
 * - "primary-first" (accept / execute, then syncs: a sync copies the NEW live
 *   authority): transaction 1 is primary + as many syncs as fit;
 * - "sync-first" (close / payout flows: the sync must land before the
 *   instruction that checks the snapshot): the primary rides in the LAST
 *   transaction, after the syncs that fit with it.
 * Every transaction after the first is a separate, sequential send; the
 * primary transaction itself stays atomic with the syncs it carries.
 */
export function bundleWithSync(
  primary: readonly Instruction[],
  syncs: readonly Instruction[],
  opts: { feePayer: Address; order: "primary-first" | "sync-first"; limit?: number },
): Instruction[][] {
  const limit = opts.limit ?? TRANSACTION_SIZE_LIMIT;
  const fits = (ixs: readonly Instruction[]) => transactionSize(opts.feePayer, ixs) <= limit;
  if (!fits(primary)) throw new Error("The instruction does not fit in one transaction");
  const chunk = (ixs: readonly Instruction[], seed: Instruction[] = []): Instruction[][] => {
    const txs: Instruction[][] = [];
    let current = seed;
    for (const ix of ixs) {
      if (fits([...current, ix])) {
        current = [...current, ix];
      } else {
        if (current.length) txs.push(current);
        current = [ix];
      }
    }
    if (current.length) txs.push(current);
    return txs;
  };
  if (opts.order === "primary-first") return chunk(syncs, [...primary]);
  // sync-first: fill the last transaction backwards from the primary.
  const tail: Instruction[] = [];
  let rest = [...syncs];
  while (rest.length && fits([rest[rest.length - 1], ...tail, ...primary])) {
    tail.unshift(rest[rest.length - 1]);
    rest = rest.slice(0, -1);
  }
  return [...chunk(rest), [...tail, ...primary]];
}

/**
 * Polls `readAuthority` (the indexer's `issuers.authority` for the issuer)
 * until it equals `expected`: role detection is indexer-first, so the new key
 * is only recognised as the issuer once the indexer has re-projected the
 * account. Resolves false when the attempts run out (the chain is already
 * right; the role catches up on the next indexer sync).
 */
export async function waitForIndexedAuthority(
  readAuthority: () => Promise<string | null>,
  expected: string,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 10;
  const delayMs = opts.delayMs ?? 3_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < attempts; i++) {
    try {
      if ((await readAuthority()) === expected) return true;
    } catch {
      // A failed read counts as "not yet".
    }
    if (i + 1 < attempts) await sleep(delayMs);
  }
  return false;
}

// ── Chain readers ────────────────────────────────────────────────────────────

const ADDRESS_DECODER = getAddressDecoder();
const read = { commitment: "confirmed" as const };

export async function findIssuerTransferPda(issuer: Address): Promise<Address> {
  return (
    await getProgramDerivedAddress({
      programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
      seeds: [new TextEncoder().encode("authority_transfer"), getAddressEncoder().encode(issuer)],
    })
  )[0];
}

export async function findIssuerRecoveryPda(issuer: Address): Promise<Address> {
  return (await findRecoveryPda({ issuer }))[0];
}

export function toPendingIssuerTransfer(t: AuthorityTransfer): PendingIssuerTransfer {
  return {
    target: t.target.toString(),
    currentAuthority: t.currentAuthority.toString(),
    newAuthority: t.newAuthority.toString(),
    proposedBy: t.proposedBy.toString(),
  };
}

export function toIssuerRecoveryRecord(r: IssuerRecovery): IssuerRecoveryRecord {
  return {
    issuer: r.issuer.toString(),
    currentAuthority: r.currentAuthority.toString(),
    newAuthority: r.newAuthority.toString(),
    proposedBy: r.proposedBy.toString(),
    proposedAt: Number(r.proposedAt),
    eta: Number(r.eta),
    expiresAt: Number(r.expiresAt),
  };
}

/** The issuer's staged regular rotation, or null. */
export async function fetchPendingIssuerTransfer(
  rpc: Rpc,
  issuer: Address,
): Promise<PendingIssuerTransfer | null> {
  const maybe = await fetchMaybeAuthorityTransfer(rpc, await findIssuerTransferPda(issuer), read);
  return maybe.exists && maybe.data.target === issuer ? toPendingIssuerTransfer(maybe.data) : null;
}

/** The issuer's pending recovery, or null. */
export async function fetchIssuerRecovery(
  rpc: Rpc,
  issuer: Address,
): Promise<IssuerRecoveryRecord | null> {
  const maybe = await fetchMaybeIssuerRecovery(rpc, await findIssuerRecoveryPda(issuer), read);
  return maybe.exists && maybe.data.issuer === issuer ? toIssuerRecoveryRecord(maybe.data) : null;
}

/** Chain time (block time of the latest slot); falls back to the local clock. */
export async function fetchChainNow(rpc: Rpc): Promise<number> {
  try {
    const slot = await rpc.getSlot({ commitment: "confirmed" }).send();
    const time = await rpc.getBlockTime(slot).send();
    if (time !== null) return Number(time);
  } catch {
    // Fall through to the local clock; the program is the source of truth.
  }
  return Math.floor(Date.now() / 1000);
}

/** The GPA filters for accounts of one type whose `new_authority` is `wallet`. */
export function pendingForWalletFilters(discriminator: Bytes, wallet: Address) {
  const base58 = getBase58Decoder();
  return [
    { memcmp: { offset: BigInt(0), encoding: "base58" as const, bytes: base58.decode(Uint8Array.from(Array.from({ length: discriminator.length }, (_, i) => discriminator[i]))) as Base58EncodedBytes } },
    { memcmp: { offset: BigInt(NEW_AUTHORITY_OFFSET), encoding: "base58" as const, bytes: wallet as unknown as Base58EncodedBytes } },
  ];
}

/** Any byte array, including the generated read-only discriminators. */
type Bytes = { readonly length: number; readonly [index: number]: number };

function hasPrefix(bytes: Bytes, prefix: Bytes): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false;
  return true;
}

async function scan(rpc: Rpc, discriminator: Bytes, wallet: Address) {
  const records = await rpc
    .getProgramAccounts(ASSET_REGISTRY_PROGRAM_ADDRESS, {
      commitment: "confirmed",
      encoding: "base64",
      filters: pendingForWalletFilters(discriminator, wallet),
    })
    .send({ abortSignal: AbortSignal.timeout(10_000) });
  return records.map((r) => ({
    address: r.pubkey,
    owner: r.account.owner,
    bytes: Uint8Array.from(atob(r.account.data[0]), (c) => c.charCodeAt(0)),
  }));
}

export type PendingForWallet = {
  /** Live or stale regular rotations of an ISSUER staged to this wallet. */
  transfers: { issuer: Address; transfer: PendingIssuerTransfer }[];
  /** Recoveries naming this wallet as the new issuer authority. */
  recoveries: { issuer: Address; recovery: IssuerRecoveryRecord }[];
};

/**
 * Everything staged for `wallet` to accept or execute. `AuthorityTransfer`
 * is shared by platform, custody and KYC-registry rotations, so a transfer is
 * kept only when its target is an Issuer account of this program.
 */
export async function findPendingForWallet(rpc: Rpc, wallet: Address): Promise<PendingForWallet> {
  const transferDisc = getAuthorityTransferDiscriminatorBytes();
  const recoveryDisc = getIssuerRecoveryDiscriminatorBytes();
  const [transfers, recoveries] = await Promise.all([
    scan(rpc, transferDisc, wallet),
    scan(rpc, recoveryDisc, wallet),
  ]);
  const out: PendingForWallet = { transfers: [], recoveries: [] };
  const issuerDisc = getIssuerDiscriminatorBytes();
  for (const t of transfers) {
    if (t.owner !== ASSET_REGISTRY_PROGRAM_ADDRESS || !hasPrefix(t.bytes, transferDisc)) continue;
    const transfer = getAuthorityTransferDecoder().decode(t.bytes);
    if (transfer.newAuthority !== wallet) continue;
    const target = await fetchEncodedAccount(rpc as unknown as Parameters<typeof fetchEncodedAccount>[0], transfer.target, read);
    if (!target.exists || target.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS || !hasPrefix(target.data, issuerDisc)) continue;
    out.transfers.push({ issuer: transfer.target, transfer: toPendingIssuerTransfer(transfer) });
  }
  for (const r of recoveries) {
    if (r.owner !== ASSET_REGISTRY_PROGRAM_ADDRESS || !hasPrefix(r.bytes, recoveryDisc)) continue;
    const recovery = getIssuerRecoveryDecoder().decode(r.bytes);
    if (recovery.newAuthority !== wallet) continue;
    if (r.address !== (await findIssuerRecoveryPda(recovery.issuer))) continue;
    out.recoveries.push({ issuer: recovery.issuer, recovery: toIssuerRecoveryRecord(recovery) });
  }
  return out;
}

export type IssuerChain = { shareClass: Address; asset: Address; issuer: Address; issuerAuthority: Address };

/**
 * `share class -> asset -> issuer`, read the way the sync instructions read
 * it: the parent key in each account's first field (byte 8), after checking
 * owner and discriminator. Works for legacy v1 share classes too.
 */
export async function resolveIssuerChain(rpc: Rpc, shareClass: Address): Promise<IssuerChain> {
  const fetch = (a: Address) =>
    fetchEncodedAccount(rpc as unknown as Parameters<typeof fetchEncodedAccount>[0], a, read);
  const parent = async (a: Address, disc: Bytes, what: string) => {
    const account = await fetch(a);
    if (!account.exists || account.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS || !hasPrefix(account.data, disc) || account.data.length < 40)
      throw new Error(`${what} ${a} is not a registry ${what.toLowerCase()}`);
    return ADDRESS_DECODER.decode(account.data.slice(8, 40));
  };
  const asset = await parent(shareClass, getShareClassDiscriminatorBytes(), "Share class");
  const issuer = await parent(asset, getAssetDiscriminatorBytes(), "Asset");
  const record = await fetchMaybeIssuer(rpc, issuer, read);
  if (!record.exists || record.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS)
    throw new Error(`Issuer ${issuer} could not be read`);
  return { shareClass, asset, issuer, issuerAuthority: record.data.authority };
}

/** `[sync_sale_authority]` when the sale's authority snapshot is out of date, else `[]`. */
export async function syncSaleIfNeeded(
  rpc: Rpc,
  sale: { address: Address; shareClass: Address; authority: Address },
): Promise<Instruction[]> {
  const chain = await resolveIssuerChain(rpc, sale.shareClass);
  return issuerSyncInstructions({
    issuer: chain.issuer,
    issuerAuthority: chain.issuerAuthority,
    sales: [{ ...sale, asset: chain.asset }],
  });
}

/** `[sync_payout_founder]` when the vault's founder snapshot is out of date, else `[]`. */
export async function syncVaultIfNeeded(
  rpc: Rpc,
  vault: { address: Address; shareClass: Address; founder: Address },
): Promise<Instruction[]> {
  const chain = await resolveIssuerChain(rpc, vault.shareClass);
  return issuerSyncInstructions({
    issuer: chain.issuer,
    issuerAuthority: chain.issuerAuthority,
    vaults: [{ ...vault, asset: chain.asset }],
  });
}

// ── Builders ─────────────────────────────────────────────────────────────────

/** `propose_issuer_authority`: the CURRENT authority stages `newAuthority`. */
export async function buildProposeIssuerAuthority(p: {
  authoritySigner: TransactionSigner;
  issuer: Address;
  newAuthority: Address;
}) {
  return getProposeIssuerAuthorityInstruction({
    authority: p.authoritySigner,
    issuer: p.issuer,
    transfer: await findIssuerTransferPda(p.issuer),
    newAuthority: p.newAuthority,
  });
}

/**
 * `accept_issuer_authority`, signed by the PROPOSED key. `currentAuthority`
 * is the live `issuer.authority`: it seeds the grant that is closed; the new
 * grant is seeded by the signer.
 */
export async function buildAcceptIssuerAuthority(p: {
  newAuthoritySigner: TransactionSigner;
  issuer: Address;
  currentAuthority: Address;
}) {
  const [transfer, oldPermissions, newPermissions] = await Promise.all([
    findIssuerTransferPda(p.issuer),
    findIssuerPermissionsAddress(p.issuer, p.currentAuthority),
    findIssuerPermissionsAddress(p.issuer, p.newAuthoritySigner.address),
  ]);
  return getAcceptIssuerAuthorityInstruction({
    newAuthority: p.newAuthoritySigner,
    issuer: p.issuer,
    transfer,
    oldPermissions,
    newPermissions,
  });
}

/** `cancel_issuer_authority_transfer`: the current authority withdraws (rent back to it). */
export async function buildCancelIssuerAuthorityTransfer(p: {
  authoritySigner: TransactionSigner;
  issuer: Address;
}) {
  return getCancelIssuerAuthorityTransferInstruction({
    authority: p.authoritySigner,
    issuer: p.issuer,
    transfer: await findIssuerTransferPda(p.issuer),
  });
}

/** `propose_issuer_recovery`: the super admin; executable after 7 days. */
export async function buildProposeIssuerRecovery(p: {
  superAdminSigner: TransactionSigner;
  issuer: Address;
  newAuthority: Address;
}) {
  const [[platform], recovery] = await Promise.all([findPlatformPda(), findIssuerRecoveryPda(p.issuer)]);
  return getProposeIssuerRecoveryInstruction({
    superAdmin: p.superAdminSigner,
    platform,
    issuer: p.issuer,
    recovery,
    newAuthority: p.newAuthority,
  });
}

/** `cancel_issuer_recovery`: the current authority or the super admin; rent to `proposer`. */
export async function buildCancelIssuerRecovery(p: {
  cancellerSigner: TransactionSigner;
  issuer: Address;
  proposer: Address;
}) {
  const [[platform], recovery] = await Promise.all([findPlatformPda(), findIssuerRecoveryPda(p.issuer)]);
  return getCancelIssuerRecoveryInstruction({
    canceller: p.cancellerSigner,
    platform,
    issuer: p.issuer,
    recovery,
    proposer: p.proposer,
  });
}

/**
 * `execute_issuer_recovery`, signed by the recovered key. Both grant PDAs are
 * derived here: the lost key's (closed) and any leftover of the new key's.
 */
export async function buildExecuteIssuerRecovery(p: {
  newAuthoritySigner: TransactionSigner;
  issuer: Address;
  currentAuthority: Address;
  proposer: Address;
}) {
  const [[platform], recovery, oldPermissions, newPermissions] = await Promise.all([
    findPlatformPda(),
    findIssuerRecoveryPda(p.issuer),
    findIssuerPermissionsAddress(p.issuer, p.currentAuthority),
    findIssuerPermissionsAddress(p.issuer, p.newAuthoritySigner.address),
  ]);
  return getExecuteIssuerRecoveryInstruction({
    newAuthority: p.newAuthoritySigner,
    platform,
    issuer: p.issuer,
    recovery,
    proposer: p.proposer,
    oldPermissions,
    newPermissions,
  });
}
