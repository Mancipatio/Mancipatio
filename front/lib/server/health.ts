// SERVER-ONLY — deployment health for uptime monitors (GET /api/health).
//
// Anonymous callers get only {ok, network, checkedAt} and the status code.
// The per-check report (queue sizes and ages, indexer and RPC state, the
// deployed commit) needs `Authorization: Bearer <HEALTH_TOKEN>`; without a
// HEALTH_TOKEN of at least 32 characters, details are never shown.
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
//   indexerQueue  oldest pending webhook job ≥ 5 min → warn (backlog),
//                 ≥ 30 min → warn (stalled). Never fail: indexer jobs have
//                 no terminal failed state, so one poison transaction stays
//                 pending forever, and a lagging index only makes browsers
//                 fall back to chain reads (same rule as a degraded indexer).
//   purchaseQueue oldest pending purchase record ≥ 5 min → warn, ≥ 30 min →
//                 fail: a user's purchase record is stuck (evidence that can
//                 never verify ends as "invalid", so a stall means the worker
//                 or what it depends on keeps failing)
//   maintenance   off → ok; on → warn (planned; reads keep working);
//                 flag unreadable → fail
//   paymentFx     the EUR rate of the network's default payment mint (USDC)
//                 that sale approvals count the raise cap with (Talas 4.2
//                 §3.6, D18). Mainnet: missing, unreadable or past its max
//                 age → fail; at ≥ 80 % of its max age → warn. Other
//                 networks: the same conditions only warn. An eur_peg row
//                 never goes stale; a network without a default mint is ok.
// Reports are shared for a few seconds per instance and concurrent requests
// share one run, so a public endpoint cannot multiply database or RPC load.

import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { detectNetwork, type Network } from "@/lib/network";
import { NetworkIdentityError } from "@/lib/network-identity";
import { defaultPaymentMint } from "@/lib/payment-mints";
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
export type PaymentFxCheck = Check & {
  kind: "rate" | "eur_peg" | null;
  ageSeconds: number | null;
  maxAgeSeconds: number | null;
};

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
    paymentFx: PaymentFxCheck;
  };
};

export const HEALTH_DB_TIMEOUT_MS = 2_500;
export const HEALTH_RPC_TIMEOUT_MS = 3_000;
export const QUEUE_WARN_SECONDS = 5 * 60;
export const QUEUE_FAIL_SECONDS = 30 * 60;
/** A rate row warns once this share of its max age has passed. */
export const FX_WARN_FRACTION = 0.8;
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

async function checkQueue(
  sb: SupabaseClient | null, table: "indexer_jobs" | "purchase_evidence_jobs", network: Network, now: number,
  stalledStatus: "warn" | "fail",
): Promise<QueueCheck> {
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
    if (oldest !== null && oldest >= QUEUE_FAIL_SECONDS) return { status: stalledStatus, reason: "stalled", ...check };
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

const INTERVAL_UNITS: Record<string, number> = {
  year: 365 * 86_400, years: 365 * 86_400, mon: 30 * 86_400, mons: 30 * 86_400,
  day: 86_400, days: 86_400,
};

/**
 * Seconds in a Postgres interval as PostgREST returns it: the default
 * "postgres" style ("7 days", "1 day 12:00:00", "12:00:00", "1 mon") or ISO
 * 8601 ("P7D", "PT12H"). Months count 30 days, years 365. Null when it is
 * not a positive interval in either form.
 */
export function intervalSeconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const iso = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(text);
  let total: number | null = null;
  if (iso && text !== "P" && !text.endsWith("T")) {
    const [, y, mo, w, d, h, mi, s] = iso.map((part) => Number(part ?? 0));
    total = y * 365 * 86_400 + mo * 30 * 86_400 + w * 7 * 86_400 + d * 86_400 + h * 3_600 + mi * 60 + s;
  } else {
    const parts = text.split(/\s+/);
    let seconds = 0;
    let i = 0;
    for (; i + 1 < parts.length && /^\d+$/.test(parts[i]) && INTERVAL_UNITS[parts[i + 1]] !== undefined; i += 2) {
      seconds += Number(parts[i]) * INTERVAL_UNITS[parts[i + 1]];
    }
    const rest = parts.slice(i);
    if (rest.length === 1) {
      const clock = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(rest[0]);
      if (!clock) return null;
      seconds += Number(clock[1]) * 3_600 + Number(clock[2]) * 60 + Number(clock[3]);
    } else if (rest.length > 1 || i === 0) {
      return null;
    }
    total = seconds;
  }
  return Number.isFinite(total) && total > 0 ? total : null;
}

async function checkPaymentFx(sb: SupabaseClient | null, network: Network, now: number): Promise<PaymentFxCheck> {
  const empty = { kind: null, ageSeconds: null, maxAgeSeconds: null } as const;
  const mint = defaultPaymentMint(network);
  if (!mint) return { status: "ok", ...empty };
  // Only a mainnet deployment is affected by a missing or stale rate (D18).
  const bad: CheckStatus = network === "mainnet" ? "fail" : "warn";
  if (!sb) return { status: bad, reason: "not_configured", ...empty };
  try {
    const result = await bounded((signal) => sb.from("fx_rates")
      .select("kind,as_of,max_age")
      .eq("network", network)
      .eq("payment_mint", mint)
      .abortSignal(signal)
      .maybeSingle(), HEALTH_DB_TIMEOUT_MS);
    if (result === TIMEOUT) return { status: bad, reason: "timeout", ...empty };
    if (result.error) return { status: bad, reason: "unavailable", ...empty };
    const row = result.data as { kind?: unknown; as_of?: unknown; max_age?: unknown } | null;
    if (!row) return { status: bad, reason: "missing", ...empty };
    if (row.kind === "eur_peg") return { status: "ok", kind: "eur_peg", ageSeconds: ageSeconds(row.as_of, now), maxAgeSeconds: null };
    const age = ageSeconds(row.as_of, now);
    const maxAge = intervalSeconds(row.max_age);
    if (row.kind !== "rate" || age === null || maxAge === null) {
      return { status: bad, reason: "invalid", kind: null, ageSeconds: age, maxAgeSeconds: maxAge };
    }
    const check = { kind: "rate" as const, ageSeconds: age, maxAgeSeconds: Math.round(maxAge) };
    if (age >= maxAge) return { status: bad, reason: "stale", ...check };
    if (age >= maxAge * FX_WARN_FRACTION) return { status: "warn", reason: "expiring", ...check };
    return { status: "ok", ...check };
  } catch {
    return { status: bad, reason: "unavailable", ...empty };
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
  const [indexer, rpc, indexerQueue, purchaseQueue, maintenance, paymentFx] = await Promise.all([
    checkIndexer(sb, network, now),
    checkRpc(),
    checkQueue(sb, "indexer_jobs", network, now, "warn"),
    checkQueue(sb, "purchase_evidence_jobs", network, now, "fail"),
    checkMaintenance(network),
    checkPaymentFx(sb, network, now),
  ]);
  const checks = { indexer, rpc, indexerQueue, purchaseQueue, maintenance, paymentFx };
  return {
    ok: Object.values(checks).every((check) => check.status !== "fail"),
    network,
    checkedAt: new Date(now).toISOString(),
    commit: commitId(),
    checks,
  };
}

export type HealthSummary = Pick<HealthReport, "ok" | "network" | "checkedAt">;

/** What anonymous callers see: enough for an uptime monitor, nothing more. */
export function summarizeHealth(report: HealthReport): HealthSummary {
  return { ok: report.ok, network: report.network, checkedAt: report.checkedAt };
}

/** Whether the caller may see the per-check report. Constant-time compare of
 * a bearer token against HEALTH_TOKEN; no token configured → never. */
export function healthDetailsAuthorized(authorization: string | null, configured = process.env.HEALTH_TOKEN): boolean {
  const secret = configured?.trim();
  if (!secret || secret.length < 32 || /\s/.test(secret)) return false;
  const supplied = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!supplied || supplied.length > 4096) return false;
  // Hash both values first so timingSafeEqual always compares equal-size buffers.
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(supplied), digest(secret));
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
