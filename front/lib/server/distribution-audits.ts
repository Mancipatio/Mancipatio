// SERVER-ONLY — the retry worker's last stage: pending "Send to wallets"
// audit rows settled from the chain.
//
// The sender's browser appends one share_class_distribution audit row per
// transaction as "pending" when it is sent, and a second row, "success" or
// "failed", once the network decided (components/send-to-wallets-panel; the
// ledger is append-only: a row is never updated, the final row is appended
// next to the pending one). When the tab closes or the RPC answers 429
// before that, only the pending row exists: in the devnet rehearsal two rows
// stayed "pending" although their transactions were confirmed. A resume of
// the run in the same browser writes the final row (reconciled_on_resume);
// a run nobody reopens never got one.
//
// This stage appends the server's own final row, checked on the chain, for
// each of those transactions: also when the browser wrote one, since
// /api/audit is unsigned and any final row posted there (the browser's, a
// resume's, or a forged one for a real signature) is a claim, not a fact.
//
// Candidates: pending share_class_distribution rows of this network, at
// least RECONCILE_MIN_AGE_MS old (younger ones are still the browser's to
// confirm) and at most RECONCILE_MAX_AGE_MS, whose signature has no row of
// this stage yet. That row is looked up by its id (reconciledAuditId), which
// /api/audit cannot write, so no self-asserted final row stops it from being
// written (lib/server/reconciled-audit). They are read OLDEST FIRST with a
// keyset cursor on (created_at, id), in two bands: the fresh band
// (RECONCILE_MIN_AGE_MS to FRESH_BAND_MS) first, then the backlog band
// (FRESH_BAND_MS to RECONCILE_MAX_AGE_MS) with the pages left. A pending row
// stays pending in the table after its final row (append-only), so a
// single oldest-first scan of the 7-day window would
// spend its pages on a week of settled history before it reached a new row;
// in the fresh band every row becomes decidable (below) and settles there,
// and the backlog band only catches what an outage left. At most `limit` ×
// CANDIDATES_PER_LIMIT candidates (≤ 200: one getSignatureStatuses call) from
// at most SCAN_PAGES pages of SCAN_PAGE rows per run.
//
// getSignatureStatuses (searchTransactionHistory, the server RPC) decides:
//   - FINALIZED without an error → "success"; FINALIZED with an error →
//     "failed" with tx_error (the client's vocabulary: success | failed |
//     pending, 0001's check);
//   - NOT FOUND, EXPIRY_HORIZON_MS (2 h) or more after its oldest pending
//     row → "failed", "Not found on chain (expired)". This is certain: the
//     app's sender signs with a recent blockhash (never a durable nonce; its
//     journal keeps lastValidBlockHeight), which is valid for 150 blocks,
//     ~60-90 s, and every pending row is written after the send, so two
//     hours after it the transaction can no longer land. (It needs an RPC
//     that keeps transaction history for the window, as the server RPCs do:
//     Helius on mainnet.) The sender's journal calls such a transaction
//     "expired" and sends its rows again under a new signature;
//   - anything else (processed, confirmed, or not found yet) stays pending
//     for a later run. Rows that cannot settle therefore hold the candidate
//     slots for at most 2 hours, never for the whole window.
//
// The server row asserts ONLY what the server checked: the signature, its
// chain status (status, chain_outcome, slot, confirmation_status, tx_error,
// or not found after the horizon), and which pending rows it settles
// (pending_row_ids, oldest first). It is the server's row: actor_wallet
// "server", target_label null, a reason of its own, metadata.actor_verified
// false / actor_source "retry-worker" (the convention of the worker's other
// rows). /api/audit is self-asserted, so what the pending row said (actor,
// reason, share class, recipients, amounts, screening evidence) is copied
// only into metadata.client_claims with verified: false, from the OLDEST
// pending row of the signature (the sender's own write at send time; a
// pending row written later by someone who saw the signature cannot replace
// it), and never at the top level where a reader would take it for checked.
// metadata.reconciled_by_server tells a human reader so, but the row is
// recognized only by what /api/audit cannot write: its id, actor
// SERVER_ACTOR and actor_source "retry-worker" (lib/server/reconciled-audit
// isReconciledAuditRow; /api/audit also drops the server row's metadata keys
// from a caller's). The pending rows are never updated.
//
// Duplicates: a transaction the browser settled also gets this stage's row,
// and the browser cannot see the server's row (anon has no SELECT on
// audit_events, 0044), so a resume that comes after it still appends its own
// (reconciled_on_resume): readers keep one final row per signature, the
// server's when there is one (lib/audit-feed collapseDistributionFinals,
// the admin audit page, through /api/audit/list's chain_checked).
//
// Idempotent and safe under concurrent runs: the retry worker's lease runs
// one stage at a time per network, and independently of it each final row's
// id is derived from (network, signature) (reconciledAuditId) and written
// with INSERT … ON CONFLICT (id) DO NOTHING, so two runs that race, or a run
// that repeats, add at most one server row per transaction. No migration
// (a partial index on pending share_class_distribution rows, or an RPC that
// does the anti-join, is a later migration if the volume ever needs it).
//
// Failures throw DistributionAuditError (stageCode "database" | "chain", the
// counts so far): the retry worker logs one structured line and reports the
// counts (lib/server/retry-worker auditStage).

import "server-only";
import { isSignature, type GetSignatureStatusesApi, type Rpc, type Signature } from "@solana/kit";
import type { SupabaseClient } from "@supabase/supabase-js";
import { detectNetwork, type Network } from "@/lib/network";
import { SERVER_ACTOR } from "@/lib/server/audit";
import { DISTRIBUTION_AUDIT_IX, RECONCILER, reconciledAuditId } from "@/lib/server/reconciled-audit";
import type { RetryCounts } from "@/lib/server/retry-worker";
import { getServerRpc } from "@/lib/server/rpc";
import { getSupabaseAdmin } from "@/lib/supabase-server";

export { DISTRIBUTION_AUDIT_IX, SERVER_ACTOR, reconciledAuditId };
/** Younger pending rows are still the browser's to confirm (it waits 60 s, then retries its audit write). */
export const RECONCILE_MIN_AGE_MS = 5 * 60_000;
/** Older pending rows are no longer looked at (aged out, no alarm). */
export const RECONCILE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** Not found this long after its oldest pending row: the blockhash (~60-90 s) has certainly expired. */
export const EXPIRY_HORIZON_MS = 2 * 60 * 60_000;
/** The fresh band, read first: every row in it reaches EXPIRY_HORIZON_MS (decidable) before it leaves. */
export const FRESH_BAND_MS = 3 * 60 * 60_000;
/** Candidates per run: the scheduler's limit (1-20) × this, at most MAX_CANDIDATES. */
export const CANDIDATES_PER_LIMIT = 10;
/** At most this many candidates per run (≤ 256 for one getSignatureStatuses call). */
export const MAX_CANDIDATES = 200;
/** Pending rows per page (the ids of their server rows go into one `in` filter: ~1.9 kB of URL). */
export const SCAN_PAGE = 50;
/** Pages of pending rows read per run at most, both bands together. */
export const SCAN_PAGES = 20;
/** Pending row ids a server row lists at most (pending_rows says how many there were). */
export const MAX_PENDING_REFS = 10;

type StatusRpc = Rpc<GetSignatureStatusesApi>;

/** One getSignatureStatuses entry (null: the node knows no such transaction). */
export type ChainStatus = { slot: bigint; err: unknown; confirmationStatus?: string | null } | null;

/** The audit status a chain status settles, or null while it is not final. */
export function finalAuditStatus(status: ChainStatus): "success" | "failed" | null {
  if (!status || status.confirmationStatus !== "finalized") return null;
  return status.err === null || status.err === undefined ? "success" : "failed";
}

/** What one run did (the retry worker's counts plus this stage's own). */
export type DistributionAuditCounts = RetryCounts & {
  /** Of `complete`: transactions not found EXPIRY_HORIZON_MS after their pending row ("failed", expired). */
  expired: number;
  /** Candidates found but not settled because the deadline, an abort or a failure came first (the next run takes them). */
  deferred: number;
};

export function emptyDistributionAuditCounts(): DistributionAuditCounts {
  return { complete: 0, pending: 0, invalid: 0, expired: 0, deferred: 0 };
}

/** The stage stopped: the database or the RPC did not answer. Carries no RPC or database message. */
export class DistributionAuditError extends Error {
  constructor(
    readonly stageCode: "database" | "chain",
    readonly counts: DistributionAuditCounts,
    options?: { cause?: unknown },
  ) {
    super(stageCode === "chain" ? "Distribution audit chain status unavailable" : "Distribution audit rows unavailable", options);
    this.name = "DistributionAuditError";
  }
}

/** A pending audit row as stored (the oldest one of a signature: its claims are copied, marked unverified). */
export type PendingAuditRow = {
  id: string;
  created_at: string;
  actor_wallet: string;
  target_label: string | null;
  tx_signature: string;
  reason: string;
  metadata: unknown;
};

/** What the chain said about one transaction, as the server row records it. */
export type ChainOutcome =
  | { kind: "finalized"; slot: bigint; err: unknown }
  /** Not found (searchTransactionHistory) EXPIRY_HORIZON_MS or more after its oldest pending row. */
  | { kind: "expired" };

/** The pending row's own report, copied as it was: the keys distributionAuditRow writes (lib/distribution-run). */
const CLAIMED_METADATA_KEYS = ["run_id", "mint", "decimals", "recipients", "total", "screening_complete"] as const;

/** JSON without bigints (a transaction error can carry one). */
function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  } catch {
    return String(value);
  }
}

/** The pending row's report, explicitly unverified (nothing in it was checked by the server row). */
function clientClaims(pending: PendingAuditRow) {
  const metadata =
    typeof pending.metadata === "object" && pending.metadata !== null && !Array.isArray(pending.metadata)
      ? (pending.metadata as Record<string, unknown>)
      : {};
  const claimed: Record<string, unknown> = {};
  for (const key of CLAIMED_METADATA_KEYS) if (key in metadata) claimed[key] = metadata[key];
  return {
    verified: false,
    row_id: pending.id,
    created_at: pending.created_at,
    actor_wallet: pending.actor_wallet,
    // How /api/audit attributed that row ("client-unsigned" or "siws-session"); its recipients are self-reported either way.
    actor_source: typeof metadata.actor_source === "string" ? metadata.actor_source : null,
    reason: pending.reason,
    target_label: pending.target_label,
    ...claimed,
  };
}

const OUTCOME_REASON = {
  success: "Finalized on chain (checked by the server)",
  failed: "Finalized on chain with an error (checked by the server)",
  expired: "Not found on chain (expired)",
} as const;

/** The final row the server appends for one transaction the chain settled. */
export function reconciledAuditRow(input: {
  network: Network;
  signature: string;
  outcome: ChainOutcome;
  /** The pending rows it settles, oldest first (at most MAX_PENDING_REFS are listed). */
  pendingIds: readonly string[];
  /** How many pending rows of this signature the scan saw. */
  pendingRows: number;
  /** When the oldest of them was written. */
  pendingCreatedAt: string;
  /** The oldest pending row, for client_claims; null when it could not be read. */
  claimsFrom: PendingAuditRow | null;
  now: Date;
}) {
  const { outcome } = input;
  const failed = outcome.kind === "expired" || (outcome.err !== null && outcome.err !== undefined);
  const chain =
    outcome.kind === "expired"
      ? { chain_outcome: "not_found_expired", expiry_horizon_ms: EXPIRY_HORIZON_MS }
      : {
          chain_outcome: failed ? "finalized_with_error" : "finalized",
          slot: outcome.slot.toString(),
          confirmation_status: "finalized",
          ...(failed ? { tx_error: jsonSafe(outcome.err) } : {}),
        };
  return {
    id: reconciledAuditId(input.network, input.signature),
    network: input.network,
    ix_name: DISTRIBUTION_AUDIT_IX,
    category: "share-class",
    actor_wallet: SERVER_ACTOR,
    target_label: null,
    tx_signature: input.signature,
    reason: outcome.kind === "expired" ? OUTCOME_REASON.expired : failed ? OUTCOME_REASON.failed : OUTCOME_REASON.success,
    status: failed ? ("failed" as const) : ("success" as const),
    metadata: {
      // What the server checked: the chain status of tx_signature…
      ...chain,
      reconciled_by_server: true,
      reconciled_by: RECONCILER,
      // …and which pending rows it settles.
      pending_row_ids: input.pendingIds.slice(0, MAX_PENDING_REFS),
      pending_rows: input.pendingRows,
      pending_created_at: input.pendingCreatedAt,
      server_received_at: input.now.toISOString(),
      // The server wrote this row; no wallet is attributed by it.
      actor_verified: false,
      actor_source: RECONCILER,
      // What the oldest pending row reported, as it was: NOT checked by this row.
      client_claims: input.claimsFrom ? clientClaims(input.claimsFrom) : null,
    },
  };
}

export type DistributionAuditDeps = {
  sb?: SupabaseClient;
  rpc?: StatusRpc;
  now?: () => number;
};

function databaseSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
}

function chainSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
}

type ScanRow = { id: string; created_at: string; tx_signature: string | null };
/** One signature to ask the chain about: its oldest pending row, the first MAX_PENDING_REFS of them, how many. */
type Candidate = { signature: string; oldest: ScanRow; refs: ScanRow[]; rows: number };

/** Whether `a` was written before `b` (the scan's order: created_at, then id). */
function before(a: ScanRow, b: ScanRow): boolean {
  const ta = Date.parse(a.created_at);
  const tb = Date.parse(b.created_at);
  return ta !== tb ? ta < tb : a.id < b.id;
}

/** At least EXPIRY_HORIZON_MS since its oldest pending row (an unreadable time never is). */
function pastExpiryHorizon(c: Candidate, nowMs: number): boolean {
  const written = Date.parse(c.oldest.created_at);
  return Number.isFinite(written) && nowMs - written >= EXPIRY_HORIZON_MS;
}

/**
 * One run of the stage (retry worker, stage() contract): complete = final
 * rows appended (expired: those not found after the horizon), pending =
 * candidates the chain has not settled yet, invalid = pending rows without
 * a usable signature, deferred = candidates left for the next run because
 * time ran out. Throws DistributionAuditError when the database or the RPC
 * cannot answer (nothing is written for the rows not reached).
 */
export async function reconcileDistributionAudits(
  limit = 10,
  deadlineMs = Date.now() + 5_000,
  parentSignal?: AbortSignal,
  deps: DistributionAuditDeps = {},
): Promise<DistributionAuditCounts> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Limit must be between 1 and 20");
  const counts = emptyDistributionAuditCounts();
  const budgetMs = deadlineMs - Date.now();
  if (budgetMs <= 0 || parentSignal?.aborted) return counts;
  const timeout = AbortSignal.timeout(budgetMs);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
  const sb = deps.sb ?? getSupabaseAdmin();
  const network = detectNetwork();
  const nowMs = (deps.now ?? Date.now)();
  const at = (msAgo: number) => new Date(nowMs - msAgo).toISOString();
  const want = Math.min(limit * CANDIDATES_PER_LIMIT, MAX_CANDIDATES);

  // 1. Candidates: pending rows without this stage's row, oldest first, the fresh band, then the backlog band.
  const bands = [
    { from: at(FRESH_BAND_MS), to: at(RECONCILE_MIN_AGE_MS), toInclusive: true },
    { from: at(RECONCILE_MAX_AGE_MS), to: at(FRESH_BAND_MS), toInclusive: false },
  ];
  const candidates: Candidate[] = [];
  const bySignature = new Map<string, Candidate>();
  const settled = new Set<string>();
  let pages = 0;
  scan: for (const band of bands) {
    let cursor: ScanRow | null = null;
    while (pages < SCAN_PAGES && candidates.length < want) {
      if (signal.aborted) break scan;
      pages++;
      // Keyset paging: the next page starts AT the last row's created_at (gte), and the rows of that
      // instant already read (id ≤ the cursor's) are skipped below. No offset, so nothing shifts.
      const after: ScanRow | null = cursor;
      const base = sb
        .from("audit_events")
        .select("id,created_at,tx_signature")
        .eq("network", network)
        .eq("ix_name", DISTRIBUTION_AUDIT_IX)
        .eq("status", "pending")
        .gte("created_at", after ? after.created_at : band.from);
      const bounded = band.toInclusive ? base.lte("created_at", band.to) : base.lt("created_at", band.to);
      const { data, error } = await bounded
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(SCAN_PAGE)
        .abortSignal(databaseSignal(signal));
      if (error) {
        counts.deferred = candidates.length;
        throw new DistributionAuditError("database", counts);
      }
      const rows = (data ?? []) as ScanRow[];
      const unseen = after ? rows.filter((r) => r.created_at !== after.created_at || r.id > after.id) : rows;
      if (rows.length > 0) cursor = rows[rows.length - 1];

      // Signatures new to this run, in scan order (their server rows are looked up together).
      const newSignatures = new Map<string, ScanRow[]>();
      for (const row of unseen) {
        // As stored (/api/audit trims it): the final row and its id use the same string.
        const signature = typeof row.tx_signature === "string" ? row.tx_signature : "";
        if (!isSignature(signature)) {
          counts.invalid++;
          continue;
        }
        if (settled.has(signature)) continue;
        const known = bySignature.get(signature);
        if (known) {
          known.rows++;
          if (known.refs.length < MAX_PENDING_REFS) known.refs.push(row);
          if (before(row, known.oldest)) known.oldest = row;
          continue;
        }
        const list = newSignatures.get(signature);
        if (list) list.push(row);
        else newSignatures.set(signature, [row]);
      }
      if (newSignatures.size > 0) {
        // Settled = this stage's own row exists (its id, which /api/audit cannot write). A final row from
        // /api/audit (the browser's, a resume's, or anyone's who saw the signature) is self-asserted and
        // settles nothing: the chain-checked row is still written next to it.
        const own = new Map<string, string>();
        for (const signature of newSignatures.keys()) own.set(reconciledAuditId(network, signature), signature);
        const finals = await sb
          .from("audit_events")
          .select("id")
          .in("id", [...own.keys()])
          .abortSignal(databaseSignal(signal));
        if (finals.error) {
          counts.deferred = candidates.length;
          throw new DistributionAuditError("database", counts);
        }
        for (const r of (finals.data ?? []) as { id: string | null }[]) {
          const signature = typeof r.id === "string" ? own.get(r.id.toLowerCase()) : undefined;
          if (signature) settled.add(signature);
        }
        for (const [signature, list] of newSignatures) {
          if (settled.has(signature) || candidates.length >= want) continue;
          const c: Candidate = { signature, oldest: list[0], refs: list.slice(0, MAX_PENDING_REFS), rows: list.length };
          bySignature.set(signature, c);
          candidates.push(c);
        }
      }
      // The band is done; or one instant holds more than a page of rows (never: each row is its own request).
      if (rows.length < SCAN_PAGE || unseen.length === 0) break;
    }
  }
  if (candidates.length === 0) return counts;
  if (signal.aborted) {
    counts.deferred = candidates.length;
    return counts;
  }

  // 2. The chain decides (one call: ≤ MAX_CANDIDATES signatures).
  let statuses: readonly (ChainStatus | undefined)[];
  try {
    const rpc = deps.rpc ?? getServerRpc();
    const { value } = await rpc
      .getSignatureStatuses(candidates.map((c) => c.signature as Signature), { searchTransactionHistory: true })
      .send({ abortSignal: chainSignal(signal) });
    statuses = value.map((s) => (s ? { slot: s.slot, err: s.err, confirmationStatus: s.confirmationStatus } : null));
  } catch (cause) {
    counts.deferred = candidates.length;
    throw new DistributionAuditError("chain", counts, { cause });
  }
  const decided: { candidate: Candidate; outcome: ChainOutcome }[] = [];
  candidates.forEach((c, i) => {
    const status = statuses[i] ?? null;
    if (finalAuditStatus(status) && status) {
      decided.push({ candidate: c, outcome: { kind: "finalized", slot: status.slot, err: status.err } });
    } else if (status === null && pastExpiryHorizon(c, nowMs)) {
      decided.push({ candidate: c, outcome: { kind: "expired" } });
    }
  });
  counts.pending = candidates.length - decided.length;
  if (decided.length === 0) return counts;
  if (signal.aborted) {
    counts.deferred = decided.length;
    return counts;
  }

  // 3. The oldest pending row of each, for client_claims (SCAN_PAGE ids at a time: they go into the URL).
  const claims = new Map<string, PendingAuditRow>();
  const ids = decided.map((d) => d.candidate.oldest.id);
  for (let i = 0; i < ids.length; i += SCAN_PAGE) {
    const full = await sb
      .from("audit_events")
      .select("id,created_at,actor_wallet,target_label,tx_signature,reason,metadata")
      .in("id", ids.slice(i, i + SCAN_PAGE))
      .abortSignal(databaseSignal(signal));
    if (full.error) {
      counts.deferred = decided.length;
      throw new DistributionAuditError("database", counts);
    }
    for (const row of (full.data ?? []) as PendingAuditRow[]) claims.set(row.id, row);
  }
  if (signal.aborted) {
    counts.deferred = decided.length;
    return counts;
  }

  // 4. One final row per settled transaction.
  const now = new Date();
  const rows = decided.map(({ candidate: c, outcome }) => {
    const oldest = claims.get(c.oldest.id);
    return reconciledAuditRow({
      network,
      signature: c.signature,
      outcome,
      pendingIds: [c.oldest, ...c.refs.filter((r) => r !== c.oldest)]
        .sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0))
        .map((r) => r.id),
      pendingRows: c.rows,
      pendingCreatedAt: c.oldest.created_at,
      claimsFrom: oldest && oldest.tx_signature === c.signature ? oldest : null,
      now,
    });
  });
  const written = await sb
    .from("audit_events")
    .upsert(rows, { onConflict: "id", ignoreDuplicates: true })
    .abortSignal(databaseSignal(signal));
  if (written.error) {
    counts.deferred = rows.length;
    throw new DistributionAuditError("database", counts);
  }
  counts.complete = rows.length;
  counts.expired = decided.filter((d) => d.outcome.kind === "expired").length;
  return counts;
}
