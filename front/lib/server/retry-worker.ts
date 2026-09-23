import "server-only";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { detectNetwork, type Network } from "@/lib/network";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { reconcileIndexerJobs } from "@/lib/server/indexer-sync";
import { reconcilePurchases } from "@/lib/server/purchase-records";
import { reconcileSaleCapacity } from "@/lib/server/sale-capacity";

export class RetryWorkerError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export type RetryCounts = { complete: number; pending: number; invalid: number };
type StageResult = { status: "processed"; counts: RetryCounts } | { status: "deferred" | "failed"; counts: null };
export type RetryWorkerResult =
  | { status: "busy"; network: Network }
  | { status: "processed" | "partial"; network: Network; indexer: StageResult; purchases: StageResult; capacity: StageResult };

const LEASE_TTL_SECONDS = 120;
const LEASE_RPC_TIMEOUT_MS = 3_000;
const RUN_BUDGET_MS = 50_000;
const STAGE_BUDGET_MS = 20_000;

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

async function stage(
  reconcile: (limit: number, deadlineMs: number, signal?: AbortSignal) => Promise<RetryCounts>,
  limit: number, workDeadline: number,
): Promise<StageResult> {
  const deadline = Math.min(Date.now() + STAGE_BUDGET_MS, workDeadline);
  if (deadline <= Date.now()) return { status: "deferred", counts: null };
  const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  try { return { status: "processed", counts: await reconcile(limit, deadline, signal) }; }
  catch {
    // Deadline exhaustion leaves durable queue rows pending for the next run.
    return { status: signal.aborted || Date.now() >= deadline ? "deferred" : "failed", counts: null };
  }
}

/** A lease protects the whole run, across instances. Cooperative aborts settle
 * before finally releases it; no Promise.race leaves a background worker alive. */
export async function runRetryWorker(limit = 10): Promise<RetryWorkerResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new RetryWorkerError(400, "Limit must be between 1 and 20");
  const network = detectNetwork(); // Never comes from scheduler-controlled input.
  const owner = randomUUID();
  const finalDeadline = Date.now() + RUN_BUDGET_MS;
  const workDeadline = finalDeadline - LEASE_RPC_TIMEOUT_MS;
  const sb = getSupabaseAdmin();
  let acquired;
  try {
    acquired = await sb.rpc("acquire_retry_worker_lease", {
      p_network: network, p_owner: owner, p_ttl_seconds: LEASE_TTL_SECONDS,
    }).abortSignal(AbortSignal.timeout(LEASE_RPC_TIMEOUT_MS));
  } catch { throw new RetryWorkerError(503, "Retry worker lease unavailable"); }
  if (acquired.error || typeof acquired.data !== "boolean") throw new RetryWorkerError(503, "Retry worker lease unavailable");
  if (!acquired.data) return { status: "busy", network };
  try {
    const indexer = await stage(reconcileIndexerJobs, limit, workDeadline);
    const purchases = await stage(reconcilePurchases, limit, workDeadline);
    // Raise-cap reservations behind sale approvals (0066): confirm, consume,
    // book closed sales, release dead approvals. The browser does each step
    // best effort; this is the backstop.
    const capacity = await stage(reconcileSaleCapacity, limit, workDeadline);
    const failed = [indexer, purchases, capacity].some((s) => s.status === "failed");
    return { status: failed ? "partial" : "processed", network, indexer, purchases, capacity };
  } finally {
    // A separate signal permits cleanup even after either queue's signal aborted.
    const releaseBudget = Math.max(1, Math.min(LEASE_RPC_TIMEOUT_MS, finalDeadline - Date.now()));
    let released;
    try {
      released = await sb.rpc("release_retry_worker_lease", { p_network: network, p_owner: owner })
        .abortSignal(AbortSignal.timeout(releaseBudget));
    } catch { throw new RetryWorkerError(503, "Retry worker lease release unavailable; lease will expire"); }
    if (released.error || released.data !== true) throw new RetryWorkerError(503, "Retry worker lease release unavailable; lease will expire");
  }
}
