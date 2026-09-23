// SERVER-ONLY — deployment health for uptime monitors (GET /api/health).
//
// Every check is bounded by a short timeout and NEVER throws: an unreachable
// database, RPC or missing configuration is reported as that check failing.
// The report carries only operational facts (states, slots, ages, counts,
// fixed reason codes) — no wallets, emails, signatures, URLs, error messages
// or any other request data.
//
// Status per check: "ok", "warn" (worth a look, the site still works) or
// "fail" (users are affected). The deployment is healthy (HTTP 200) unless a
// check fails (HTTP 503):
//   indexer       ready → ok; warming / not initialized / degraded → warn
//                 (the browser falls back to chain reads, see lib/indexer.ts)
//   rpc           server RPC answers getSlot → ok; else fail
//   indexerQueue  oldest pending webhook job ≥ 5 min → warn, ≥ 30 min → fail
//   purchaseQueue oldest pending purchase record ≥ 5 min → warn, ≥ 30 min → fail
//   maintenance   off → ok; on → warn (planned; reads keep working);
//                 flag unreadable → fail
// Reports are shared for a few seconds per instance and concurrent requests
// share one run, so a public endpoint cannot multiply database or RPC load.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { detectNetwork, type Network } from "@/lib/network";
import { NetworkIdentityError } from "@/lib/network-identity";
import { readMaintenance } from "@/lib/server/maintenance";
import { getServerRpc } from "@/lib/server/rpc";
import { getSupabaseAdmin } from "@/lib/supabase-server";

export type CheckStatus = "ok" | "warn" | "fail";
export type FailureReason = "not_configured" | "timeout" | "unavailable" | "wrong_network";
type Check = { status: CheckStatus; reason?: string };

export type IndexerCheck = Check & {
  state: "ready" | "warming" | "degraded" | null;
  lastSlot: number | null;
  checkedAgeSeconds: number | null;
  completedAgeSeconds: number | null;
  /** Whether browsers read the index right now (mirrors lib/indexer.ts). */
  fresh: boolean;
};
export type RpcCheck = Check & { slot: number | null; latencyMs: number | null };
export type QueueCheck = Check & { pending: number | null; oldestPendingAgeSeconds: number | null };
export type MaintenanceCheck = Check & { enabled: boolean | null };

export type HealthReport = {
  ok: boolean;
  network: Network;
  checkedAt: string;
  commit: string | null;
  checks: {
    indexer: IndexerCheck;
    rpc: RpcCheck;
    indexerQueue: QueueCheck;
    purchaseQueue: QueueCheck;
    maintenance: MaintenanceCheck;
  };
};

export const HEALTH_DB_TIMEOUT_MS = 2_500;
export const HEALTH_RPC_TIMEOUT_MS = 3_000;
export const QUEUE_WARN_SECONDS = 5 * 60;
export const QUEUE_FAIL_SECONDS = 30 * 60;
/** lib/indexer.ts stops trusting the index after this long without a check. */
const INDEX_FRESH_SECONDS = 5 * 60;
const CACHE_MS = 5_000;

const TIMEOUT = Symbol("timeout");

/** Run `work` with an abort signal; resolve TIMEOUT when it takes longer than
 * `ms`. The late result (or rejection) of the abandoned work is discarded. */
async function bounded<T>(work: (signal: AbortSignal) => PromiseLike<T>, ms: number): Promise<T | typeof TIMEOUT> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(TIMEOUT); }, ms);
  });
  const task = Promise.resolve().then(() => work(controller.signal));
  task.catch(() => {});
  try {
    return await Promise.race([task, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function ageSeconds(value: unknown, now: number): number | null {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.round((now - at) / 1000));
}

function safeInteger(value: unknown): number | null {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value)
    : typeof value === "number" || typeof value === "bigint" ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

async function checkIndexer(sb: SupabaseClient | null, network: Network, now: number): Promise<IndexerCheck> {
  const empty = { state: null, lastSlot: null, checkedAgeSeconds: null, completedAgeSeconds: null, fresh: false } as const;
  if (!sb) return { status: "fail", reason: "not_configured", ...empty };
  try {
    const result = await bounded((signal) => sb.from("indexer_sync_state")
      .select("status,last_slot,checked_at,completed_at")
      .eq("network", network)
      .abortSignal(signal)
      .maybeSingle(), HEALTH_DB_TIMEOUT_MS);
    if (result === TIMEOUT) return { status: "fail", reason: "timeout", ...empty };
    if (result.error) return { status: "fail", reason: "unavailable", ...empty };
    const row = result.data as { status?: unknown; last_slot?: unknown; checked_at?: unknown; completed_at?: unknown } | null;
    if (!row) return { status: "warn", reason: "not_initialized", ...empty };
    const state: IndexerCheck["state"] = row.status === "ready" || row.status === "warming" || row.status === "degraded" ? row.status : null;
    const checkedAgeSeconds = ageSeconds(row.checked_at, now);
    const completedAgeSeconds = ageSeconds(row.completed_at, now);
    const fresh = state === "ready" && completedAgeSeconds !== null
      && checkedAgeSeconds !== null && checkedAgeSeconds <= INDEX_FRESH_SECONDS;
    const check = { state, lastSlot: safeInteger(row.last_slot), checkedAgeSeconds, completedAgeSeconds, fresh };
    if (state === "ready") return { status: "ok", ...check };
    return { status: "warn", reason: state ?? "unknown_state", ...check };
  } catch {
    return { status: "fail", reason: "unavailable", ...empty };
  }
}

async function checkQueue(sb: SupabaseClient | null, table: "indexer_jobs" | "purchase_evidence_jobs", network: Network, now: number): Promise<QueueCheck> {
  const empty = { pending: null, oldestPendingAgeSeconds: null } as const;
  if (!sb) return { status: "fail", reason: "not_configured", ...empty };
  try {
    // One round trip: the exact pending count plus the oldest pending row.
    const result = await bounded((signal) => sb.from(table)
      .select("created_at", { count: "exact" })
      .eq("network", network)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(1)
      .abortSignal(signal), HEALTH_DB_TIMEOUT_MS);
    if (result === TIMEOUT) return { status: "fail", reason: "timeout", ...empty };
    const pending = safeInteger(result.count);
    if (result.error || pending === null) return { status: "fail", reason: "unavailable", ...empty };
    const oldest = pending > 0 ? ageSeconds((result.data as { created_at?: unknown }[] | null)?.[0]?.created_at, now) : null;
    const check = { pending, oldestPendingAgeSeconds: oldest };
    if (oldest !== null && oldest >= QUEUE_FAIL_SECONDS) return { status: "fail", reason: "stalled", ...check };
    if (oldest !== null && oldest >= QUEUE_WARN_SECONDS) return { status: "warn", reason: "backlog", ...check };
    return { status: "ok", ...check };
  } catch {
    return { status: "fail", reason: "unavailable", ...empty };
  }
}

async function checkRpc(): Promise<RpcCheck> {
  const empty = { slot: null, latencyMs: null } as const;
  let rpc: ReturnType<typeof getServerRpc>;
  try {
    rpc = getServerRpc();
  } catch {
    // Mainnet without a server RPC, or a conflicting genesis configuration.
    return { status: "fail", reason: "not_configured", ...empty };
  }
  const started = Date.now();
  try {
    const slot = await bounded((signal) => rpc.getSlot({ commitment: "confirmed" }).send({ abortSignal: signal }), HEALTH_RPC_TIMEOUT_MS);
    if (slot === TIMEOUT) return { status: "fail", reason: "timeout", ...empty };
    const value = safeInteger(slot);
    if (value === null) return { status: "fail", reason: "unavailable", ...empty };
    return { status: "ok", slot: value, latencyMs: Date.now() - started };
  } catch (error) {
    // Never echo RPC errors: they can carry the provider URL and its API key.
    const identity = error instanceof NetworkIdentityError
      || (error instanceof Error && error.name === "NetworkIdentityError");
    const wrongNetwork = identity && /different network/.test((error as Error).message);
    return { status: "fail", reason: wrongNetwork ? "wrong_network" : "unavailable", ...empty };
  }
}

async function checkMaintenance(network: Network): Promise<MaintenanceCheck> {
  try {
    const reading = await bounded(() => readMaintenance(network), HEALTH_DB_TIMEOUT_MS);
    if (reading === TIMEOUT) return { status: "fail", reason: "timeout", enabled: null };
    if (!reading.fresh) return { status: "fail", reason: "unavailable", enabled: reading.enabled };
    return reading.enabled ? { status: "warn", reason: "maintenance", enabled: true } : { status: "ok", enabled: false };
  } catch {
    return { status: "fail", reason: "unavailable", enabled: null };
  }
}

function commitId(): string | null {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
  return sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 12) : null;
}

/** Run every check once, in parallel. Throws only for an invalid network setting. */
export async function runHealthChecks(): Promise<HealthReport> {
  const network = detectNetwork();
  const now = Date.now();
  let sb: SupabaseClient | null = null;
  try {
    sb = getSupabaseAdmin();
  } catch {
    sb = null;
  }
  const [indexer, rpc, indexerQueue, purchaseQueue, maintenance] = await Promise.all([
    checkIndexer(sb, network, now),
    checkRpc(),
    checkQueue(sb, "indexer_jobs", network, now),
    checkQueue(sb, "purchase_evidence_jobs", network, now),
    checkMaintenance(network),
  ]);
  const checks = { indexer, rpc, indexerQueue, purchaseQueue, maintenance };
  return {
    ok: Object.values(checks).every((check) => check.status !== "fail"),
    network,
    checkedAt: new Date(now).toISOString(),
    commit: commitId(),
    checks,
  };
}

let cached: { at: number; report: HealthReport } | null = null;
let inflight: Promise<HealthReport> | null = null;

/** The latest report, at most a few seconds old; concurrent callers share one run. */
export async function readHealth(): Promise<HealthReport> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.report;
  if (!inflight) {
    inflight = runHealthChecks()
      .then((report) => {
        cached = { at: Date.now(), report };
        return report;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
