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
// This stage appends that final row from the server:
//   - candidates are pending share_class_distribution rows of this network
//     with a transaction signature, created between RECONCILE_MAX_AGE_MS and
//     RECONCILE_MIN_AGE_MS ago (younger ones are still the browser's to
//     confirm), with no "success" / "failed" row for the same signature yet
//     (the browser's, a resume's or this stage's own). Newest first, so rows
//     that can never be settled can only hold back older ones, never the
//     ones that come after them; at most `limit` × CANDIDATES_PER_LIMIT per
//     run (≤ 256, one getSignatureStatuses call), from at most SCAN_PAGES
//     pages of pending rows;
//   - getSignatureStatuses (searchTransactionHistory, the server RPC) decides
//     each one: FINALIZED without an error → "success", FINALIZED with an
//     error → "failed" (the client's vocabulary: success | failed | pending,
//     0001's check). Anything else (not found, processed, confirmed) stays
//     pending for a later run;
//   - never "expired": a pending audit row stores no lastValidBlockHeight
//     (that lives in the sender's browser journal), so the server cannot be
//     certain a transaction it does not find can no longer land, and 0001
//     has no such status. A row that is never found stays pending and simply
//     ages out of the window after RECONCILE_MAX_AGE_MS — no alarm, no row
//     (the admin audit page keeps showing it as pending).
//
// The final row repeats the pending row's claims as they were (actor,
// reason, target, recipients, amounts, screening evidence, and its
// actor_verified / actor_source: an unsigned row stays marked unverified)
// and adds what the server read from the chain: status, slot,
// confirmation_status, tx_error. metadata.reconciled_by_server marks it.
//
// Idempotent and safe under concurrent runs: the retry worker's lease runs
// one stage at a time per network, and independently of it each final row's
// id is derived from (network, signature) (reconciledAuditId) and written
// with INSERT … ON CONFLICT (id) DO NOTHING, so two runs that race, or a run
// that repeats, add at most one server row per transaction. No migration.

import "server-only";
import { createHash } from "node:crypto";
import { isSignature, type GetSignatureStatusesApi, type Rpc, type Signature } from "@solana/kit";
import type { SupabaseClient } from "@supabase/supabase-js";
import { detectNetwork, type Network } from "@/lib/network";
import type { RetryCounts } from "@/lib/server/retry-worker";
import { getServerRpc } from "@/lib/server/rpc";
import { getSupabaseAdmin } from "@/lib/supabase-server";

export const DISTRIBUTION_AUDIT_IX = "share_class_distribution";
/** Younger pending rows are still the browser's to confirm (it waits 60 s, then retries its audit write). */
export const RECONCILE_MIN_AGE_MS = 5 * 60_000;
/** Older pending rows are no longer looked at (aged out, no alarm). */
export const RECONCILE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** Candidates per run: the scheduler's limit (1-20) × this, at most 200 (≤ 256 for one status call). */
export const CANDIDATES_PER_LIMIT = 10;
/** Pending rows per page (their signatures go into one `in` filter: ~4.5 kB of URL). */
export const SCAN_PAGE = 50;
/** Pages of pending rows read per run at most. */
export const SCAN_PAGES = 20;

const RECONCILER = "retry-worker";

type StatusRpc = Rpc<GetSignatureStatusesApi>;

/** One getSignatureStatuses entry (null: the node knows no such transaction). */
export type ChainStatus = { slot: bigint; err: unknown; confirmationStatus?: string | null } | null;

/** The audit status a chain status settles, or null while it is not final. */
export function finalAuditStatus(status: ChainStatus): "success" | "failed" | null {
  if (!status || status.confirmationStatus !== "finalized") return null;
  return status.err === null || status.err === undefined ? "success" : "failed";
}

/**
 * The id of the server's final row for one transaction: a UUID (version 8,
 * RFC 9562) from SHA-256 of the network and the signature, so a second
 * write of it is a conflict, never a second row.
 */
export function reconciledAuditId(network: string, signature: string): string {
  const h = createHash("sha256").update(`manci:distribution-audit:v1:${network}:${signature}`).digest();
  h[6] = (h[6] & 0x0f) | 0x80;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** A pending audit row as stored. */
export type PendingAuditRow = {
  id: string;
  created_at: string;
  category: string | null;
  actor_wallet: string;
  target_label: string | null;
  tx_signature: string;
  reason: string;
  metadata: unknown;
};

/** JSON without bigints (a transaction error can carry one). */
function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  } catch {
    return String(value);
  }
}

/** The final row the server appends for one pending row the chain settled. */
export function reconciledAuditRow(
  pending: PendingAuditRow,
  outcome: "success" | "failed",
  status: NonNullable<ChainStatus>,
  network: Network,
  now: Date,
) {
  const claims =
    typeof pending.metadata === "object" && pending.metadata !== null && !Array.isArray(pending.metadata)
      ? (pending.metadata as Record<string, unknown>)
      : {};
  return {
    id: reconciledAuditId(network, pending.tx_signature),
    network,
    ix_name: DISTRIBUTION_AUDIT_IX,
    category: pending.category ?? "share-class",
    actor_wallet: pending.actor_wallet,
    target_label: pending.target_label,
    tx_signature: pending.tx_signature,
    reason: pending.reason,
    status: outcome,
    metadata: {
      // The pending row's claims, its actor_verified / actor_source included, as they were…
      ...claims,
      // …and what the server read from the chain.
      server_received_at: now.toISOString(),
      reconciled_by_server: true,
      reconciled_by: RECONCILER,
      reconciled_from: pending.id,
      pending_created_at: pending.created_at,
      slot: status.slot.toString(),
      confirmation_status: "finalized",
      ...(outcome === "failed" ? { tx_error: jsonSafe(status.err) } : {}),
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

/**
 * One run of the stage (retry worker, stage() contract): counts are
 * complete = final rows appended, pending = candidates the chain has not
 * settled yet, invalid = pending rows without a usable signature. Throws
 * when the database or the RPC cannot answer (the stage is then "failed";
 * nothing was written for the rows not reached).
 */
export async function reconcileDistributionAudits(
  limit = 10,
  deadlineMs = Date.now() + 5_000,
  parentSignal?: AbortSignal,
  deps: DistributionAuditDeps = {},
): Promise<RetryCounts> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Limit must be between 1 and 20");
  const counts: RetryCounts = { complete: 0, pending: 0, invalid: 0 };
  const budgetMs = deadlineMs - Date.now();
  if (budgetMs <= 0 || parentSignal?.aborted) return counts;
  const timeout = AbortSignal.timeout(budgetMs);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
  const sb = deps.sb ?? getSupabaseAdmin();
  const network = detectNetwork();
  const nowMs = (deps.now ?? Date.now)();
  const newest = new Date(nowMs - RECONCILE_MIN_AGE_MS).toISOString();
  const oldest = new Date(nowMs - RECONCILE_MAX_AGE_MS).toISOString();
  const want = Math.min(limit * CANDIDATES_PER_LIMIT, 200);

  // 1. Pending rows of the window without a final row, newest first.
  const candidates: { id: string; signature: string }[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < SCAN_PAGES && candidates.length < want; page++) {
    if (signal.aborted) return counts;
    const from = page * SCAN_PAGE;
    const { data, error } = await sb
      .from("audit_events")
      .select("id,tx_signature")
      .eq("network", network)
      .eq("ix_name", DISTRIBUTION_AUDIT_IX)
      .eq("status", "pending")
      .gte("created_at", oldest)
      .lte("created_at", newest)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + SCAN_PAGE - 1)
      .abortSignal(databaseSignal(signal));
    if (error) throw new Error("Distribution audit rows unavailable");
    const rows = (data ?? []) as { id: string; tx_signature: string | null }[];
    const usable: { id: string; signature: string }[] = [];
    for (const row of rows) {
      // As stored (/api/audit trims it): the final row and its id use the same string.
      const signature = typeof row.tx_signature === "string" ? row.tx_signature : "";
      if (!isSignature(signature)) {
        counts.invalid++;
        continue;
      }
      // Duplicate pending rows of one transaction: the newest stands for them all.
      if (seen.has(signature)) continue;
      seen.add(signature);
      usable.push({ id: row.id, signature });
    }
    if (usable.length > 0) {
      const finals = await sb
        .from("audit_events")
        .select("tx_signature")
        .eq("network", network)
        .eq("ix_name", DISTRIBUTION_AUDIT_IX)
        .in("status", ["success", "failed"])
        .in("tx_signature", usable.map((u) => u.signature))
        .abortSignal(databaseSignal(signal));
      if (finals.error) throw new Error("Distribution audit rows unavailable");
      const settled = new Set(((finals.data ?? []) as { tx_signature: string | null }[]).map((r) => r.tx_signature));
      for (const u of usable) if (!settled.has(u.signature) && candidates.length < want) candidates.push(u);
    }
    if (rows.length < SCAN_PAGE) break;
  }
  if (candidates.length === 0 || signal.aborted) return counts;

  // 2. The chain decides (one call: ≤ 200 signatures).
  const rpc = deps.rpc ?? getServerRpc();
  const { value } = await rpc
    .getSignatureStatuses(candidates.map((c) => c.signature as Signature), { searchTransactionHistory: true })
    .send({ abortSignal: chainSignal(signal) });
  const decided = new Map<string, { outcome: "success" | "failed"; status: NonNullable<ChainStatus> }>();
  candidates.forEach((c, i) => {
    const s = value[i] ?? null;
    const status: ChainStatus = s ? { slot: s.slot, err: s.err, confirmationStatus: s.confirmationStatus } : null;
    const outcome = finalAuditStatus(status);
    if (outcome && status) decided.set(c.id, { outcome, status });
  });
  counts.pending = candidates.length - decided.size;
  if (decided.size === 0 || signal.aborted) return counts;

  // 3. One final row per settled transaction, from its full pending row
  //    (read SCAN_PAGE ids at a time: they go into the URL).
  const ids = [...decided.keys()];
  const pendingRows: PendingAuditRow[] = [];
  for (let i = 0; i < ids.length; i += SCAN_PAGE) {
    const full = await sb
      .from("audit_events")
      .select("id,created_at,category,actor_wallet,target_label,tx_signature,reason,metadata")
      .in("id", ids.slice(i, i + SCAN_PAGE))
      .abortSignal(databaseSignal(signal));
    if (full.error) throw new Error("Distribution audit rows unavailable");
    pendingRows.push(...((full.data ?? []) as PendingAuditRow[]));
  }
  if (signal.aborted) return counts;
  const now = new Date();
  const rows = pendingRows
    .filter((p) => decided.has(p.id))
    .map((p) => {
      const d = decided.get(p.id)!;
      return reconciledAuditRow(p, d.outcome, d.status, network, now);
    });
  counts.pending += decided.size - rows.length;
  if (rows.length === 0) return counts;
  const written = await sb
    .from("audit_events")
    .upsert(rows, { onConflict: "id", ignoreDuplicates: true })
    .abortSignal(databaseSignal(signal));
  if (written.error) throw new Error("Distribution audit rows not written");
  counts.complete = rows.length;
  return counts;
}
