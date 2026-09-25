import "server-only";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { detectNetwork, type Network } from "@/lib/network";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { isDeploymentNetworkError } from "@/lib/server/deployment-network";
import { runIndexerHeartbeat, type Freshness } from "@/lib/server/indexer-heartbeat";
import { reconcileIndexerJobs } from "@/lib/server/indexer-sync";
import { reconcilePurchases } from "@/lib/server/purchase-records";
import { reconcileSaleCapacity } from "@/lib/server/sale-capacity";
import { reconcileLedger } from "@/lib/server/spv-issuance-jobs";

export class RetryWorkerError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export type RetryCounts = { complete: number; pending: number; invalid: number };
export type StageResult = { status: "processed"; counts: RetryCounts } | { status: "deferred" | "failed"; counts: null };
export type RetryWorkerResult =
  | { status: "busy"; network: Network }
  | {
    status: "processed" | "partial"; network: Network;
    indexer: StageResult; purchases: StageResult; ledger: StageResult; capacity: StageResult;
    /** The indexer freshness heartbeat (0075). Never part of `partial`. */
    freshness: Freshness;
  };

const LEASE_TTL_SECONDS = 120;
const LEASE_RPC_TIMEOUT_MS = 3_000;
const HEARTBEAT_TIMEOUT_MS = 2_000;
const RUN_BUDGET_MS = 50_000;
/** Per-stage budgets (design §3g): indexer, purchases, the ledger (0073),
 * then the 2B capacity backstop with what is left (at most 20 s). */
export const STAGE_BUDGETS_MS = { indexer: 15_000, purchases: 10_000, ledger: 10_000, capacity: 20_000 } as const;

/** No fallback credential, and no secret or request body enters logs/responses. */
export function requireRetryWorkerAuthorization(authorization: string | null): void {
  const secret = process.env.RETRY_WORKER_SECRET?.trim();
  if (!secret || secret.length < 32 || /\s/.test(secret)) {
    throw new RetryWorkerError(503, "Retry worker is not configured");
  }
  const supplied = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!supplied || supplied.length > 4096) throw new RetryWorkerError(401, "Unauthorized");
  // Hash both values first so timingSafeEqual always compares equal-size buffers.
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(digest(supplied), digest(secret))) throw new RetryWorkerError(401, "Unauthorized");
}

export function retryWorkerLimit(value: string | null): number {
  if (value === null) return 10;
  if (!/^(?:[1-9]|1[0-9]|20)$/.test(value)) throw new RetryWorkerError(400, "Limit must be between 1 and 20");
  return Number(value);
}

export async function stage(
  reconcile: (limit: number, deadlineMs: number, signal?: AbortSignal) => Promise<RetryCounts>,
  limit: number, budgetMs: number, workDeadline: number,
): Promise<StageResult> {
  const deadline = Math.min(Date.now() + budgetMs, workDeadline);
  if (deadline <= Date.now()) return { status: "deferred", counts: null };
  const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  try { return { status: "processed", counts: await reconcile(limit, deadline, signal) }; }
  catch {
    // Deadline exhaustion leaves durable queue rows pending for the next run.
    return { status: signal.aborted || Date.now() >= deadline ? "deferred" : "failed", counts: null };
  }
}

/** Lease errors: a database that serves another network is its own answer. */
export function leaseError(error: unknown, worker: string): RetryWorkerError {
  if (isDeploymentNetworkError(error as { code?: unknown; message?: unknown })) {
    return new RetryWorkerError(503, "Deployment network mismatch");
  }
  return new RetryWorkerError(503, `${worker} lease unavailable`);
}

/** A lease protects the whole run, across instances. Cooperative aborts settle
 * before finally releases it; no Promise.race leaves a background worker alive. */
export async function runRetryWorker(limit = 10): Promise<RetryWorkerResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new RetryWorkerError(400, "Limit must be between 1 and 20");
  const network = detectNetwork(); // Never comes from scheduler-controlled input.
  const owner = randomUUID();
  const started = new Date();
  const finalDeadline = Date.now() + RUN_BUDGET_MS;
  const workDeadline = finalDeadline - LEASE_RPC_TIMEOUT_MS;
  const sb = getSupabaseAdmin();
  let acquired;
  try {
    // 0072: the lease asserts the deployment network first.
    acquired = await sb.rpc("acquire_retry_worker_lease", {
      p_network: network, p_owner: owner, p_ttl_seconds: LEASE_TTL_SECONDS,
    }).abortSignal(AbortSignal.timeout(LEASE_RPC_TIMEOUT_MS));
  } catch { throw new RetryWorkerError(503, "Retry worker lease unavailable"); }
  if (acquired.error) throw leaseError(acquired.error, "Retry worker");
  if (typeof acquired.data !== "boolean") throw new RetryWorkerError(503, "Retry worker lease unavailable");
  if (!acquired.data) return { status: "busy", network };
  let status: "processed" | "partial" = "partial";
  try {
    // The heartbeat runs after the job loop, inside the indexer stage's budget
    // (the later stages' deadlines are unchanged). It never throws; a decline
    // is its own field and never makes the run partial.
    let freshness: Freshness = { status: "skipped", reason: "INDEXER_STAGE" };
    const indexer = await stage(async (l, deadline, signal) => {
      const counts = await reconcileIndexerJobs(l, deadline, signal);
      try {
        freshness = await runIndexerHeartbeat(deadline, signal);
      } catch {
        freshness = { status: "declined", reason: "INTERNAL_ERROR" };
      }
      return counts;
    }, limit, STAGE_BUDGETS_MS.indexer, workDeadline);
    const purchases = await stage(reconcilePurchases, limit, STAGE_BUDGETS_MS.purchases, workDeadline);
    // The €3M ledger (0073): closed sales and treasury mints the indexer and
    // the alarm worker enqueued, booked from the finalized chain.
    const ledger = await stage(reconcileLedger, limit, STAGE_BUDGETS_MS.ledger, workDeadline);
    // Raise-cap reservations behind sale approvals (0066): confirm, consume,
    // release dead approvals, orphan scans. The backstop of every step.
    const capacity = await stage(reconcileSaleCapacity, limit, STAGE_BUDGETS_MS.capacity, workDeadline);
    const failed = [indexer, purchases, ledger, capacity].some((s) => s.status === "failed");
    status = failed ? "partial" : "processed";
    return { status, network, indexer, purchases, ledger, capacity, freshness };
  } finally {
    // Best effort, bounded: the alarm worker watches this heartbeat.
    try {
      await sb.rpc("record_worker_heartbeat", {
        p_network: network, p_worker: "retry", p_status: status, p_started_at: started.toISOString(), p_gap_scan: false,
      }).abortSignal(AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS));
    } catch {
      console.error("[retry-worker] heartbeat not recorded");
    }
    // A separate signal permits cleanup even after either queue's signal aborted.
    // Worst case: 47 s of work + 2 s heartbeat + 3 s release, inside maxDuration 60.
    const releaseBudget = Math.max(1_000, Math.min(LEASE_RPC_TIMEOUT_MS, finalDeadline + HEARTBEAT_TIMEOUT_MS - Date.now()));
    let released;
    try {
      released = await sb.rpc("release_retry_worker_lease", { p_network: network, p_owner: owner })
        .abortSignal(AbortSignal.timeout(releaseBudget));
    } catch { throw new RetryWorkerError(503, "Retry worker lease release unavailable; lease will expire"); }
    if (released.error || released.data !== true) throw new RetryWorkerError(503, "Retry worker lease release unavailable; lease will expire");
  }
}
