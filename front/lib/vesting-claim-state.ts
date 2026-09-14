// Claim-page state derivation (F04). Pure functions over decoded accounts +
// a clock, so the portfolio page can re-derive on a ticking `now` and the
// tests can pin the transitions (locked → claimable, next-unlock countdown,
// draft/cancelled/done). The loader keeps failed series reads as explicit
// error entries instead of dropping the position.

import type { SolanaClient } from "@solana/client";
import {
  VestingDeliveryMode,
  VestingSeriesStatus,
  VestingTimingMode,
  type VestingPosition,
  type VestingSeries,
} from "@/lib/generated/asset_registry";
import {
  fetchSeriesByPda,
  loadPositionsForWallet,
  positionClaimable,
  type LoadedPosition,
} from "@/lib/vesting-series";

export type ClaimStatus =
  | "draft" // series not finalized — nothing deliverable
  | "cancelled" // series cancelled — vested part stays deliverable
  | "done" // released ≥ allocation
  | "unfunded" // finalized but escrow does not cover the allocation
  | "awaiting_approval" // tranche unlocked, waiting for approval/window
  | "claimable" // > 0 deliverable right now
  | "locked"; // nothing unlocked yet — countdown to next unlock

export type ClaimState = {
  status: ClaimStatus;
  claimable: bigint;
  push: boolean;
  /** Next tranche unlock strictly after `now` (unix s), if any. */
  nextUnlockTs: number | null;
  /** Seconds until `nextUnlockTs` (≥ 0), or null. */
  secondsToNextUnlock: number | null;
};

export function deriveClaimState(
  series: VestingSeries,
  position: VestingPosition,
  now: number,
): ClaimState {
  const push = series.deliveryMode === VestingDeliveryMode.Push;
  const claimable = positionClaimable(series, position, now);
  const futureUnlocks = series.tranches
    .map((t) => Number(t.unlockTs))
    .filter((ts) => ts > now)
    .sort((a, b) => a - b);
  const nextUnlockTs = futureUnlocks.length > 0 ? futureUnlocks[0] : null;
  const secondsToNextUnlock =
    nextUnlockTs === null ? null : Math.max(0, nextUnlockTs - now);
  const base = { claimable, push, nextUnlockTs, secondsToNextUnlock };

  if (position.released >= position.allocation)
    return { ...base, status: "done" };
  if (series.status === VestingSeriesStatus.Draft)
    return { ...base, status: "draft" };
  if (claimable > BigInt(0)) return { ...base, status: "claimable" };
  if (series.status === VestingSeriesStatus.Cancelled)
    return { ...base, status: "cancelled" };
  if (
    series.totalAllocated === BigInt(0) ||
    series.deposited < series.totalAllocated
  )
    return { ...base, status: "unfunded" };
  if (hasTranchePendingApproval(series, now))
    return { ...base, status: "awaiting_approval" };
  return { ...base, status: "locked" };
}

/**
 * Approval mode only: true when at least one tranche is unlocked at `now`
 * but is neither approved (bit set in `approvedMask`) nor past its approval
 * window. Tranches that are already approved (and therefore claimed or
 * claimable) or whose window lapsed are deliverable, not pending — counting
 * them would report "awaiting approval" for every approval-mode series after
 * its first claim. Auto mode never waits for approval.
 */
export function hasTranchePendingApproval(
  series: VestingSeries,
  now: number,
): boolean {
  if (series.timingMode !== VestingTimingMode.Approval) return false;
  const window = Number(series.approvalWindowSecs);
  return series.tranches.some((t, i) => {
    const unlockTs = Number(t.unlockTs);
    if (unlockTs > now) return false;
    const approved =
      (series.approvedMask & (BigInt(1) << BigInt(i))) !== BigInt(0);
    const lapsed = unlockTs + window <= now;
    return !approved && !lapsed;
  });
}

/** "2d 03:04:05" / "03:04:05" — for the countdown next to the button. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p2 = (n: number) => String(n).padStart(2, "0");
  const hms = `${p2(h)}:${p2(m)}:${p2(sec)}`;
  return d > 0 ? `${d}d ${hms}` : hms;
}

// ── loading with explicit per-series errors ────────────────────────────────

export type PositionEntry =
  | { kind: "ok"; position: LoadedPosition; series: VestingSeries }
  | {
      kind: "error";
      position: LoadedPosition;
      seriesPda: string;
      error: string;
    };

type Rpc = SolanaClient["runtime"]["rpc"];

type SeriesReader = (
  rpc: Rpc,
  pda: string,
) => Promise<VestingSeries | null>;
type PositionsReader = (
  rpc: Rpc,
  wallet: Parameters<typeof loadPositionsForWallet>[1],
) => Promise<LoadedPosition[]>;

/**
 * Loads every position of `wallet` and its series. A series whose RPC read
 * or decoding fails becomes an `error` entry (with the message) rather than
 * being silently omitted; a position whose series account is genuinely gone
 * is also reported as an error, since the position is then unusable.
 */
export async function loadPositionEntries(
  rpc: Rpc,
  wallet: Parameters<typeof loadPositionsForWallet>[1],
  readers: { positions?: PositionsReader; series?: SeriesReader } = {},
): Promise<PositionEntry[]> {
  const readPositions = readers.positions ?? loadPositionsForWallet;
  const readSeries = readers.series ?? fetchSeriesByPda;
  const positions = await readPositions(rpc, wallet);
  const out: PositionEntry[] = [];
  for (const position of positions) {
    const seriesPda = position.account.series.toString();
    try {
      const series = await readSeries(rpc, seriesPda);
      if (series) out.push({ kind: "ok", position, series });
      else
        out.push({
          kind: "error",
          position,
          seriesPda,
          error: "Series account not found on this network.",
        });
    } catch (err) {
      out.push({
        kind: "error",
        position,
        seriesPda,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
