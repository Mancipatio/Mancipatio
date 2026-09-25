"use client";

// Vesting series — client self-serve token vesting (spec: "11. Vesting —
// Manci"). Off-chain intake/review wrappers + on-chain readers + the
// mirror of the program's vesting math (util.rs). A series is CLIENT-owned:
// the client's wallet is the on-chain authority for approval, recovery and
// cancellation — Manci holds no key over the escrow.

import {
  type Address,
  getBase58Encoder,
  type ReadonlyUint8Array,
} from "@solana/kit";
import type { SolanaClient, WalletSession } from "@solana/client";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  getVestingPositionDecoder,
  getVestingPositionDiscriminatorBytes,
  getVestingSeriesDecoder,
  getVestingSeriesDiscriminatorBytes,
  VestingDeliveryMode,
  VestingSeriesStatus,
  VestingTimingMode,
  type VestingPosition,
  type VestingSeries,
  type VestingTranche,
} from "@/lib/generated/asset_registry";
import { signedFetch } from "@/lib/siws-client";
import { notifyAdminBadges } from "@/lib/admin-badges-events";

export {
  VestingDeliveryMode,
  VestingSeriesStatus,
  VestingTimingMode,
  type VestingPosition,
  type VestingSeries,
  type VestingTranche,
};

// ── constants (mirror of program constants.rs) ───────────────────────────────

export { MAX_WALLET_VESTING_TRANCHES as MAX_VESTING_TRANCHES } from "@/lib/vesting-terms";
export const MIN_APPROVAL_WINDOW_SECS = 3_600;
export const MAX_APPROVAL_WINDOW_SECS = 7_776_000;

// ── DB row types (migration 0043) ────────────────────────────────────────────

export type VestingSeriesDbStatus =
  | "submitted"
  | "needs_changes"
  | "approved"
  | "rejected"
  | "created"
  | "cancelled";

export type ScheduleEntry = { unlock_ts: number; amount: string };
export type RecipientEntry = { wallet: string; allocation: string };

export type VestingSeriesRow = {
  id: string;
  created_at: string;
  updated_at: string;
  network: string;
  client_wallet: string;
  client_id: string | null;
  token_mint: string;
  token_label: string;
  timing_mode: "auto" | "approval";
  delivery_mode: "push" | "claim";
  approval_window_secs: number;
  recovery_enabled: boolean;
  cancellation_enabled: boolean;
  pre_cliff_bps: number;
  schedule: ScheduleEntry[];
  recipients: RecipientEntry[];
  status: VestingSeriesDbStatus;
  review_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  series_id: string | null;
  series_pda: string | null;
  escrow: string | null;
  created_tx: string | null;
  cancelled_tx: string | null;
  approved_terms_hash: string | null;
  creation_terms_hash: string | null;
  creation_prepared_at: string | null;
};

// ── vesting math (mirror of util.rs — keep in sync!) ─────────────────────────

/** Cumulative scheduled amount unlocked at `ts` (ownership basis). */
export function vestingCumulative(
  tranches: VestingTranche[],
  ts: number,
): bigint {
  let acc = BigInt(0);
  for (const t of tranches) if (Number(t.unlockTs) <= ts) acc += t.amount;
  return acc;
}

/** Cumulative DELIVERABLE amount at `ts` — cancel override, funding gate,
 *  approval mask / window. Mirror of `vesting_deliverable_cumulative`. */
export function vestingDeliverableCumulative(
  series: VestingSeries,
  ts: number,
): bigint {
  if (series.status === VestingSeriesStatus.Draft) return BigInt(0);
  if (series.status === VestingSeriesStatus.Cancelled)
    return series.finalCumulative;
  if (
    series.totalAllocated === BigInt(0) ||
    series.deposited < series.totalAllocated
  )
    return BigInt(0);
  if (series.timingMode === VestingTimingMode.Auto)
    return vestingCumulative(series.tranches, ts);
  let acc = BigInt(0);
  series.tranches.forEach((t, i) => {
    const approved =
      (series.approvedMask & (BigInt(1) << BigInt(i))) !== BigInt(0);
    const lapsed = Number(t.unlockTs) + Number(series.approvalWindowSecs) <= ts;
    if (Number(t.unlockTs) <= ts && (approved || lapsed)) acc += t.amount;
  });
  return acc;
}

/** A position's deliverable entitlement (floored pro-rata share). */
export function positionEntitlement(
  allocation: bigint,
  deliverableCumulative: bigint,
  totalAllocated: bigint,
): bigint {
  if (totalAllocated === BigInt(0)) return BigInt(0);
  return (allocation * deliverableCumulative) / totalAllocated;
}

/** What a position can claim/receive right now (never negative). */
export function positionClaimable(
  series: VestingSeries,
  position: VestingPosition,
  ts: number,
): bigint {
  const d = vestingDeliverableCumulative(series, ts);
  const e = positionEntitlement(position.allocation, d, series.totalAllocated);
  return e > position.released ? e - position.released : BigInt(0);
}

// ── on-chain readers ─────────────────────────────────────────────────────────

type Rpc = SolanaClient["runtime"]["rpc"];
type RawEntry = { pubkey: Address; data: Uint8Array };

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function fetchAllProgramAccounts(rpc: Rpc): Promise<RawEntry[]> {
  const res = await rpc
    .getProgramAccounts(ASSET_REGISTRY_PROGRAM_ADDRESS, { encoding: "base64" })
    .send();
  return res.map((r) => ({
    pubkey: r.pubkey,
    data: b64ToBytes((r.account.data as readonly [string, string])[0]),
  }));
}

function hasDisc(data: Uint8Array, disc: ReadonlyUint8Array): boolean {
  if (data.length < disc.length + 32) return false;
  for (let i = 0; i < disc.length; i += 1)
    if (data[i] !== disc[i]) return false;
  return true;
}

function fieldEquals(data: Uint8Array, offset: number, b58: string): boolean {
  const bytes = getBase58Encoder().encode(b58);
  if (data.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1)
    if (data[offset + i] !== bytes[i]) return false;
  return true;
}

export type LoadedSeries = { pda: Address; account: VestingSeries };
export type LoadedPosition = { pda: Address; account: VestingPosition };

/** Every vesting series whose on-chain authority is `authority`. */
export async function loadSeriesForAuthority(
  rpc: Rpc,
  authority: string,
): Promise<LoadedSeries[]> {
  const disc = getVestingSeriesDiscriminatorBytes();
  const dec = getVestingSeriesDecoder();
  const out: LoadedSeries[] = [];
  for (const r of await fetchAllProgramAccounts(rpc)) {
    // layout: disc(8) authority(32) …
    if (!hasDisc(r.data, disc) || !fieldEquals(r.data, 8, authority)) continue;
    try {
      out.push({ pda: r.pubkey, account: dec.decode(r.data) });
    } catch {
      // short / legacy layout — skip
    }
  }
  return out;
}

/** Every position of a series. */
export async function loadPositionsForSeries(
  rpc: Rpc,
  seriesPda: string,
): Promise<LoadedPosition[]> {
  const disc = getVestingPositionDiscriminatorBytes();
  const dec = getVestingPositionDecoder();
  const out: LoadedPosition[] = [];
  for (const r of await fetchAllProgramAccounts(rpc)) {
    // layout: disc(8) series(32) index(4) wallet(32) …
    if (!hasDisc(r.data, disc) || !fieldEquals(r.data, 8, seriesPda)) continue;
    try {
      out.push({ pda: r.pubkey, account: dec.decode(r.data) });
    } catch {
      // skip
    }
  }
  out.sort((a, b) => a.account.index - b.account.index);
  return out;
}

/** Every position whose CURRENT wallet is `wallet` (recipient view). */
export async function loadPositionsForWallet(
  rpc: Rpc,
  wallet: string,
): Promise<LoadedPosition[]> {
  const disc = getVestingPositionDiscriminatorBytes();
  const dec = getVestingPositionDecoder();
  const out: LoadedPosition[] = [];
  for (const r of await fetchAllProgramAccounts(rpc)) {
    // wallet offset = disc(8) + series(32) + index(4) = 44
    if (!hasDisc(r.data, disc) || !fieldEquals(r.data, 44, wallet)) continue;
    try {
      out.push({ pda: r.pubkey, account: dec.decode(r.data) });
    } catch {
      // skip
    }
  }
  return out;
}

/** Fetch one series account by PDA. Returns null ONLY when the account does
 *  not exist; an RPC or decoding failure throws so callers can surface it
 *  instead of presenting a failed read as a missing position (F04). */
export async function fetchSeriesByPda(
  rpc: Rpc,
  pda: string,
): Promise<VestingSeries | null> {
  const res = await rpc
    .getAccountInfo(pda as Address, { encoding: "base64" })
    .send();
  if (!res.value) return null;
  const data = b64ToBytes((res.value.data as readonly [string, string])[0]);
  return getVestingSeriesDecoder().decode(data);
}

/** Fetch one series account by PDA (null when missing/undecodable). Prefer
 *  fetchSeriesByPda where a read failure must be visible. */
export async function loadSeriesByPda(
  rpc: Rpc,
  pda: string,
): Promise<VestingSeries | null> {
  try {
    return await fetchSeriesByPda(rpc, pda);
  } catch {
    return null;
  }
}

// ── signed API wrappers (routes: app/api/vesting-series/*) ───────────────────

export type CreateVestingSeriesInput = {
  tokenMint: string;
  tokenLabel: string;
  timingMode: "auto" | "approval";
  deliveryMode: "push" | "claim";
  approvalWindowSecs: number;
  recoveryEnabled: boolean;
  cancellationEnabled: boolean;
  preCliffBps: number;
  schedule: ScheduleEntry[];
  recipients: RecipientEntry[];
};

export async function createVestingSeriesRequest(
  session: WalletSession | null | undefined,
  input: CreateVestingSeriesInput,
): Promise<string> {
  const data = await signedFetch<{ id: string }>(
    session,
    "/api/vesting-series/create",
    "vesting-series.create",
    {
      token_mint: input.tokenMint,
      token_label: input.tokenLabel,
      timing_mode: input.timingMode,
      delivery_mode: input.deliveryMode,
      approval_window_secs: input.approvalWindowSecs,
      recovery_enabled: input.recoveryEnabled,
      cancellation_enabled: input.cancellationEnabled,
      pre_cliff_bps: input.preCliffBps,
      schedule: input.schedule,
      recipients: input.recipients,
    },
  );
  return data.id;
}

/** Resubmit a series the team sent back for fixes (needs_changes → submitted). */
export async function resubmitVestingSeries(
  session: WalletSession | null | undefined,
  id: string,
  input: CreateVestingSeriesInput,
): Promise<void> {
  await signedFetch(
    session,
    "/api/vesting-series/update",
    "vesting-series.update",
    {
      id,
      token_mint: input.tokenMint,
      token_label: input.tokenLabel,
      timing_mode: input.timingMode,
      delivery_mode: input.deliveryMode,
      approval_window_secs: input.approvalWindowSecs,
      recovery_enabled: input.recoveryEnabled,
      cancellation_enabled: input.cancellationEnabled,
      pre_cliff_bps: input.preCliffBps,
      schedule: input.schedule,
      recipients: input.recipients,
    },
  );
}

export async function listMyVestingSeries(
  session: WalletSession | null | undefined,
): Promise<VestingSeriesRow[]> {
  const data = await signedFetch<{ rows: VestingSeriesRow[] }>(
    session,
    "/api/vesting-series/list-mine",
    "vesting-series.list-mine",
    {},
  );
  return data.rows;
}

/** Stamp the on-chain PDA + creation tx after the client creates the series. */
export async function markVestingSeriesCreated(
  session: WalletSession | null | undefined,
  id: string,
  seriesId: string,
  seriesPda: string,
  escrow: string,
  tx: string,
): Promise<void> {
  await signedFetch(
    session,
    "/api/vesting-series/mark-created",
    "vesting-series.mark-created",
    { id, series_id: seriesId, series_pda: seriesPda, escrow, tx },
  );
}

/** Stamp the cancellation tx after the client cancels the series on-chain. */
export async function markVestingSeriesCancelled(
  session: WalletSession | null | undefined,
  id: string,
  tx: string,
): Promise<void> {
  await signedFetch(
    session,
    "/api/vesting-series/mark-cancelled",
    "vesting-series.mark-cancelled",
    { id, tx },
  );
}

// ── admin wrappers ───────────────────────────────────────────────────────────

export async function adminListVestingSeries(
  session: WalletSession | null | undefined,
): Promise<VestingSeriesRow[]> {
  const data = await signedFetch<{ rows: VestingSeriesRow[] }>(
    session,
    "/api/vesting-series/admin-list",
    "vesting-series.admin-list",
    {},
  );
  return data.rows;
}

export async function adminReviewVestingSeries(
  session: WalletSession | null | undefined,
  id: string,
  decision: "approved" | "needs_changes" | "rejected",
  reason: string,
): Promise<void> {
  await signedFetch(
    session,
    "/api/vesting-series/admin-review",
    "vesting-series.admin-review",
    { id, decision, reason },
  );
  notifyAdminBadges();
}

export async function prepareVestingCreation(
  session: WalletSession,
  row: VestingSeriesRow,
) {
  const result = await signedFetch<{ row: VestingSeriesRow }>(
    session,
    "/api/vesting-series/prepare-creation",
    "vesting-series.prepare-creation",
    { id: row.id, terms_hash: row.approved_terms_hash },
  );
  return result.row;
}
export async function recordVestingCreationStep(
  session: WalletSession,
  id: string,
  step: string,
  signature: string,
) {
  return signedFetch<{ status: "verified" }>(
    session,
    "/api/vesting-series/record-step",
    "vesting-series.record-step",
    { id, step, signature },
  );
}
export async function fetchVestingCreationState(
  session: WalletSession,
  id: string,
) {
  return signedFetch<{
    exists: boolean;
    positionsCount: number;
    status: VestingSeriesStatus | null;
    deposited: string;
    totalAllocated: string;
    receipts: {
      step_key: string;
      signature: string;
      state: string;
      slot: string | null;
    }[];
  }>(
    session,
    "/api/vesting-series/creation-state",
    "vesting-series.creation-state",
    { id },
  );
}
