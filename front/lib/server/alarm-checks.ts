// SERVER-ONLY — the alarm worker's checks (Talas 4.4b, design §3e/§4.2).
//
// Each check reports fail / hold / pass to report_incident (0072), which
// applies the hysteresis: an incident opens on the first failure, clears
// after 3 passes and 5 minutes without a failure, and a failure within 30
// minutes of a clear reopens the same alert silently. Clear thresholds sit
// below the fail thresholds; between them a check reports hold.
//
// Order: the cheap checks (queues, degraded, invalid jobs, the retry
// heartbeat, FX and holds, indexer freshness) are read AND recorded first;
// the gap scan runs after them under its own sub-deadline (the checks deadline minus
// GAP_SCAN_RESERVE_MS), so a slow RPC can never cost the other incidents,
// and its own incidents are recorded in the reserve. A scan that was started
// counts as run (last_gap_scan_at is stamped) even when it is cut short, and
// reports gap-scan-incomplete, so a slow scan is retried every 5 minutes,
// never every minute. `expected` counts every report and every check that
// could not run; the alarm worker treats recorded < expected as a failed
// stage (a partial run that never moves last_ok_at).
//
// When the last scan started is read FIRST (one heartbeat row), so a due
// scan is known even when the cheap checks use the whole budget. A scan that
// is due but gets no time, or whose due state could not be read, counts in
// `expected` like any check that could not run (a partial stage), and every
// run reports gap-scan-overdue from that stamp: pass when a scan ran or is
// not yet due, hold while one is due, fail once none has started for
// GAP_SCAN_OVERDUE_MS. A backstop that keeps being skipped is never silent.
//
// The gap scan (at most every 5 minutes) lists the finalized signatures of
// the watched addresses (the asset_registry program ID, the
// blocklist-authority PDA, both ProgramData PDAs, and the transfer_hook
// program ID) in [now − 20 min, now − 5 min]; any missing from
// indexer_events is fetched (finalized) and, when it invokes a watched
// program (or its status meta is missing, so a CPI could be hidden), enqueued
// through the indexer's own path (enqueue_indexer_events), which repairs the
// mirror, and whose 0072 trigger creates the alarm job (source gap-scan). A
// listed transaction that invokes none of them (anyone can list the
// blocklist-authority PDA or a program ID as a read-only account; the webhook
// never delivers the PDA ones) is ignored: not missing, not enqueued. Only
// public account keys and {"source":"gap-scan"} are written.
// The transfer_hook program ID is listed so that a missed hook-only
// transaction is repaired too: the freshness heartbeat (0075) requires every
// successful transaction of both programs to be indexed. Every hooked
// transfer lists it, so it is paged last on its own budget
// (GAP_SCAN_HOOK_PAGES) and running out of it does not fail
// gap-scan-incomplete (`hook_complete` in its evidence): a hook-only
// transaction changes no mirrored account (Execute writes nothing; the only
// mirrored hook accounts, the blocklist-authority proposal and recovery of
// 0079, are written by the hook's authority instructions, which carry the
// blocklist-authority PDA) and its config is created through asset_registry,
// both scanned in full. (A KYC-gated transfer also lists the asset_registry
// program ID, as an extra account meta: at that volume its own listing runs
// out of pages too.)
//
// indexer-freshness (0075): how long the mirror has gone without being
// proven in sync, from the newer of indexer_sync_state.checked_at (jobs and
// reconciles keep it fresh while the network is busy) and the heartbeat's
// last proof. Pass while the heartbeat is off, hold while the indexer is not
// ready (indexer-degraded reports that) or for the first 30 minutes of a
// heartbeat that has not recorded a run (after that a heartbeat whose every
// plan or confirm call fails is judged by the age like any other); low
// severity in observe mode (never emailed), medium in on.
// sanctions-list (0078, 8.5): the OFAC SDN list the screened routes trust.
// Unusable (older than 3 days, empty, never loaded): high and failing on
// mainnet (the routes refuse). Before that, an early warning while the
// routes still work: the last refresh attempt failed, or the list is older
// than 36 hours (the daily job missed a run, or is disabled): medium and
// failing on mainnet, so ops hears of it a day or more before the routes
// stop. Elsewhere both hold (nothing opens).
// role-change-pending (0079, high): the "timelock running" incident, open
// while the mirror holds a live staged Admin grant, Super Admin rotation or
// upgrade-authority recovery (v1.0.0-rc D3/D4). payout-modules (critical,
// mainnet): the mirrored Platform must keep bit 0x40 set (D2). Before 0079
// role-change-pending reports nothing. bootstrap-open (critical, mainnet):
// the one-way bootstrap window (bit 0x80) is open while an emergency area is
// clear — a live platform on which add_admin and the Super Admin rotation
// skip their 48 h (an rc.x rollback that unpaused and came back to v1) — or
// has stayed open, fully paused, for BOOTSTRAP_WINDOW_MAX_HOURS since the
// Platform's first indexed transaction (Day D is over, S5c was forgotten).
// The half of chain:inventory's rule that needs the role map (the final
// Super Admin holds the platform) stays in chain:inventory.
// indexer-reconcile-age (0075, low): the last full reconcile is older than
// reconcile_max_age_hours (default 168). Not a freshness condition: the
// heartbeat keeps proving from its watermarks; a reconcile also catches what
// a transaction-level proof cannot (an account a job never wrote).
// Before 0075 is applied neither reports anything.
//
// fx-expiring:<mint> (medium, front-app-14 / lansiranje-15): a "rate" row of
// a mint in use, or of the network's default payment mint (on mainnet a
// stale one fails /api/health), is within FX expiry warning of its max age
// (the smaller of FX_EXPIRY_WARN_MS and half the max age: day 5 of the
// mainnet 7-day rate) and not yet past it. The rate is refreshed by hand on
// /admin/limits, so the reminder comes before sales stop. Past the max age it
// passes: fx-stale reports a mint in use from then on (and /api/health the
// default mint on mainnet), so one condition is never two alerts.
// From 0080 these three judge the rate that COUNTS (lib/fx-effective.ts):
// the automatic one while fresh, else the manual row; fx-expiring is about
// the manual rate only (the automatic one is renewed every minute) and the
// automatic rate has its own checks (fxAutoReports: fx-auto-stale,
// fx-fallback, fx-source-down, fx-depeg, fx-divergence, fx-jump). While the
// automatic rate counts, fx-fallback watches the manual row behind it (the
// one that takes over when the automatic rate stops), so it cannot expire
// unnoticed.
//
// The operational watches (lib/server/ops-watch.ts: SOL balances of the
// operational keys and the Squads multisig, when configured) read the chain,
// so they run AFTER the cheap incidents are recorded, in parallel with the
// gap scan, under their own budget (OPS_WATCH_BUDGET_MS, ending
// OPS_WATCH_RESERVE_MS before the checks deadline; each chain read bounded
// too), and record their incidents as soon as they finish: a slow or hanging
// RPC costs neither the cheap incidents nor the gap scan. A watch that cannot
// finish is a check that could not run.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ASSET_REGISTRY_PROGRAM_ADDRESS } from "@/lib/generated/asset_registry";
import { TRANSFER_HOOK_PROGRAM_ADDRESS, findBlocklistAuthorityPda } from "@/lib/generated/transfer_hook";
import { detectNetwork, type Network } from "@/lib/network";
import { defaultPaymentMint, paymentMintLabel } from "@/lib/payment-mints";
import {
  FX_JUMP_THRESHOLD, FX_JUMP_WINDOW_MS, FX_REFUSAL_STREAK, FX_SOURCE_DOWN_MS, FX_SOURCES, autoFxMint, type FxSourceId,
} from "@/lib/fx-auto";
import { fxRowFresh, resolveFxRates, type FxAutoRow, type FxManualRow, type FxOrigin } from "@/lib/fx-effective";
import { tableMissing } from "@/lib/server/fx-rates";
import { QUEUE_FAIL_SECONDS, QUEUE_WARN_SECONDS, checkQueue, intervalSeconds, type QueueTable } from "@/lib/server/health";
import { BPF_LOADER_UPGRADEABLE, LOADER_V4, programDataAddresses, type ProgramDataAddresses } from "@/lib/server/onchain-alarms";
import { opsWatchReports } from "@/lib/server/ops-watch";
import { OFAC_SDN_SOURCE } from "@/lib/ofac-sdn";
import { EMERGENCY_PAUSE_BITS, PAUSE_PAYOUT_MODULES, PLATFORM_BOOTSTRAP_OPEN, formatPauseFlags } from "@/lib/pause-flags";
import { listProblem, SANCTIONS_MAX_LIST_AGE_MS } from "@/lib/server/sanctions";
import { finalizedTransaction, listFinalizedSignatures } from "@/lib/server/sale-capacity-chain";
import { reportIncident, type AlertCategory, type IncidentState, type Severity } from "@/lib/server/system-alerts";
import { flattenInvocations, hasInvocationMeta, resolveAccountKeys, type InvocationTx } from "@/lib/server/tx-invocations";

export const GAP_SCAN_EVERY_MS = 5 * 60_000;
export const GAP_WINDOW = { fromMs: 20 * 60_000, toMs: 5 * 60_000 } as const;
export const GAP_SCAN_PAGES = 5;
/** The transfer_hook program ID's own page budget (every hooked transfer lists it). */
export const GAP_SCAN_HOOK_PAGES = 2;
export const GAP_REPAIR_MAX = 20;
/** The part of the checks budget kept for recording the gap scan's own incidents. */
export const GAP_SCAN_RESERVE_MS = 3_000;
/** No gap scan started for this long: gap-scan-overdue fails (three missed turns). */
export const GAP_SCAN_OVERDUE_MS = 15 * 60_000;
const LEDGER_QUEUE_FAIL_SECONDS = 30 * 60;
const LEDGER_QUEUE_CLEAR_SECONDS = 15 * 60;
const INDEXER_DEGRADED_SECONDS = 10 * 60;
const RETRY_FAIL_SECONDS = 10 * 60;
const RETRY_CLEAR_SECONDS = 3 * 60;
const HOLD_FAIL_SECONDS = 30 * 60;
const FRESHNESS_FAIL_SECONDS = 15 * 60;
const FRESHNESS_CLEAR_SECONDS = 3 * 60;
/** A heartbeat row younger than this that has not recorded a run holds (bootstrap). */
const FRESHNESS_BOOTSTRAP_SECONDS = 30 * 60;
const RECONCILE_MAX_AGE_HOURS_DEFAULT = 168;
/** fx-expiring warns this long before a rate's max age (capped at half the max age). */
export const FX_EXPIRY_WARN_MS = 2 * 24 * 3_600_000;
/** The operational watches' budget within the checks stage. */
export const OPS_WATCH_BUDGET_MS = 8_000;
/** The part of the checks budget the operational watches leave for recording their incidents. */
export const OPS_WATCH_RESERVE_MS = 1_000;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type CheckReport = { check: string; state: IncidentState; severity: Severity };
/** `hookComplete`: whether the transfer_hook listing reached the window start (never part of `complete`). */
export type GapScanResult = { missing: number; repaired: number; ignored: number; complete: boolean; hookComplete: boolean };
export type ChecksResult = {
  /** The incidents recorded through report_incident. */
  reports: CheckReport[];
  /** Reports that should have been recorded plus checks that could not run. */
  expected: number;
  /** ran: a scan was started (last_gap_scan_at is stamped); cutShort: it did not finish. */
  gapScan: ({ ran: true; cutShort: boolean } & GapScanResult) | null;
};

type Report = Omit<CheckReport, "severity"> & {
  severity: Severity; category: AlertCategory; source: string; summary: string; evidence?: Record<string, unknown>;
};

function dbSignal(signal: AbortSignal) {
  return AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
}

/** fail / hold / pass by a fail threshold and a lower clear threshold. */
export function thresholdState(value: number | null, fail: number, clear: number): IncidentState {
  if (value === null) return "pass";
  if (value >= fail) return "fail";
  if (value < clear) return "pass";
  return "hold";
}

/** One queue's lag incident; null when the queue could not be read. */
async function queueReport(
  sb: SupabaseClient, network: Network, now: number, table: QueueTable,
): Promise<Report | null> {
  const q = await checkQueue(sb, table, network, now, "fail");
  if (q.reason === "timeout" || q.reason === "unavailable" || q.reason === "not_configured") return null;
  const age = q.oldestPendingAgeSeconds;
  if (table === "spv_issuance_jobs") {
    return { check: "ledger-queue", state: thresholdState(age, LEDGER_QUEUE_FAIL_SECONDS, LEDGER_QUEUE_CLEAR_SECONDS),
      severity: "high", category: "ledger", source: "ledger:queue-lag",
      summary: `Raise-cap ledger queue: the oldest pending job is ${Math.round((age ?? 0) / 60)} minutes old`,
      evidence: { oldest_pending_seconds: age } };
  }
  const [check, category, source, label] = table === "indexer_jobs"
    ? ["indexer-queue", "indexer", "indexer:queue-lag", "Indexer"] as const
    : ["event-queue", "worker", "worker:event-queue", "Alarm"] as const;
  return { check, state: thresholdState(age, QUEUE_WARN_SECONDS, QUEUE_WARN_SECONDS / 2),
    severity: age !== null && age >= QUEUE_FAIL_SECONDS ? "high" : "medium", category, source,
    summary: `${label} queue: the oldest pending job is ${Math.round((age ?? 0) / 60)} minutes old`,
    evidence: { oldest_pending_seconds: age } };
}

/** Degraded for ≥ 10 min, approximated by a degraded state whose oldest pending indexer job is that old. */
async function indexerDegraded(sb: SupabaseClient, network: Network, now: number, signal: AbortSignal): Promise<Report | null> {
  const { data, error } = await sb.from("indexer_sync_state").select("status").eq("network", network)
    .abortSignal(dbSignal(signal)).maybeSingle();
  if (error) return null;
  const status = (data as { status?: string } | null)?.status ?? null;
  const base = { check: "indexer-degraded", severity: "medium" as const, category: "indexer" as const, source: "indexer:degraded" };
  if (status !== "degraded") return { ...base, state: status === "ready" ? "pass" : "hold", summary: "The indexer is ready" };
  const q = await checkQueue(sb, "indexer_jobs", network, now, "fail");
  const age = q.oldestPendingAgeSeconds;
  return { ...base, state: age !== null && age >= INDEXER_DEGRADED_SECONDS ? "fail" : "hold",
    summary: "The indexer is degraded: a webhook job keeps failing", evidence: { oldest_pending_seconds: age } };
}

/** An error that means the relation is not there yet (0075 not applied). */
function missingRelation(error: { code?: unknown } | null): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205";
}

/** indexer-reconcile-age (low): the last full reconcile against reconcile_max_age_hours. */
function reconcileAge(completedAt: string | null | undefined, maxHours: number, now: number): Report {
  const at = Date.parse(completedAt ?? "");
  const hours = Number.isFinite(at) ? Math.max(0, (now - at) / 3_600_000) : null;
  const state: IncidentState = hours === null || hours >= maxHours ? "fail" : "pass";
  return {
    check: "indexer-reconcile-age", category: "indexer", source: "indexer:reconcile-age", severity: "low", state,
    summary: hours === null
      ? "The indexer has never completed a full reconcile (/admin/health → Reconcile)"
      : `The last full indexer reconcile ran ${Math.floor(hours)} hour(s) ago${state === "fail" ? " (/admin/health → Reconcile)" : ""}`,
    evidence: { hours_since_reconcile: hours === null ? null : Math.floor(hours), max_age_hours: maxHours },
  };
}

/** indexer-freshness and indexer-reconcile-age; [] before 0075 is applied (nothing to watch), null when they could not be read. */
async function indexerFreshness(sb: SupabaseClient, network: Network, now: number, signal: AbortSignal): Promise<Report[] | null> {
  const [hbRes, syncRes] = await Promise.all([
    sb.from("indexer_heartbeat_state").select("mode,last_attempt_at,last_proven_at,last_reason,created_at,reconcile_max_age_hours")
      .eq("network", network).abortSignal(dbSignal(signal)).maybeSingle(),
    sb.from("indexer_sync_state").select("status,checked_at,completed_at").eq("network", network)
      .abortSignal(dbSignal(signal)).maybeSingle(),
  ]);
  if (hbRes.error && missingRelation(hbRes.error)) return [];
  if (hbRes.error || syncRes.error) return null;
  type Heartbeat = {
    mode?: string; last_attempt_at?: string | null; last_proven_at?: string | null; last_reason?: string | null;
    created_at?: string | null; reconcile_max_age_hours?: number | null;
  };
  const hb = hbRes.data as Heartbeat | null;
  const sync = syncRes.data as { status?: string; checked_at?: string | null; completed_at?: string | null } | null;
  const maxHours = Number.isSafeInteger(hb?.reconcile_max_age_hours) && hb!.reconcile_max_age_hours! > 0
    ? hb!.reconcile_max_age_hours! : RECONCILE_MAX_AGE_HOURS_DEFAULT;
  const reconcile = reconcileAge(sync?.completed_at, maxHours, now);
  const mode = hb?.mode ?? null;
  const reason = hb?.last_reason && /^[A-Z_]{1,40}$/.test(hb.last_reason) ? hb.last_reason : null;
  const base = {
    check: "indexer-freshness", category: "indexer" as const, source: "indexer:freshness",
    severity: (mode === "on" ? "medium" : "low") as Severity,
  };
  if (mode === "off") return [{ ...base, state: "pass", summary: "The indexer freshness heartbeat is off", evidence: { mode } }, reconcile];
  // Bootstrap: no recorded run yet. Bounded, so a heartbeat whose every plan
  // or confirm call fails (DB_ERROR is never recorded) is judged by the age below.
  const created = Date.parse(hb?.created_at ?? "");
  if (!hb || (!hb.last_attempt_at && (!Number.isFinite(created) || now - created < FRESHNESS_BOOTSTRAP_SECONDS * 1000))) {
    return [{ ...base, state: "hold", summary: "The indexer freshness heartbeat has not run yet", evidence: { mode } }, reconcile];
  }
  if (sync?.status !== "ready" || !sync.completed_at) {
    return [{ ...base, state: "hold", summary: "The indexer is not ready, so the heartbeat cannot prove it", evidence: { mode, reason } }, reconcile];
  }
  // The newer of the two that exist (Math.max with a NaN would be NaN: a heartbeat that never proved would hide fresh jobs).
  const stamps = [sync.checked_at, hb.last_proven_at].map((v) => Date.parse(v ?? "")).filter(Number.isFinite);
  const proven = stamps.length ? Math.max(...stamps) : Number.NaN;
  const age = Number.isFinite(proven) ? Math.max(0, (now - proven) / 1000) : Number.POSITIVE_INFINITY;
  const minutes = Number.isFinite(age) ? Math.floor(age / 60) : null;
  const unrecorded = !hb.last_attempt_at ? " (the heartbeat has not recorded a run: is 0075 applied and the schema cache reloaded?)" : "";
  const summary = minutes === null
    ? `The indexer mirror has never been proven in sync${unrecorded}; the site reads the chain`
    : `The indexer mirror was last proven in sync ${minutes} minute(s) ago${reason ? ` (heartbeat: ${reason})` : ""}${unrecorded}; the site reads the chain`;
  return [{ ...base, state: thresholdState(age, FRESHNESS_FAIL_SECONDS, FRESHNESS_CLEAR_SECONDS), summary,
    evidence: { mode, reason, minutes_since_proof: minutes, recorded: !!hb.last_attempt_at } }, reconcile];
}

async function eventInvalid(sb: SupabaseClient, network: Network, now: number, signal: AbortSignal): Promise<Report | null> {
  const { data, error } = await sb.from("onchain_event_jobs").select("last_error").eq("network", network).eq("status", "invalid")
    .gte("updated_at", new Date(now - 24 * 3_600_000).toISOString()).limit(200).abortSignal(dbSignal(signal));
  if (error) return null;
  const codes: Record<string, number> = {};
  for (const row of (data ?? []) as { last_error: string | null }[]) {
    const code = row.last_error && /^[A-Z_]{1,40}$/.test(row.last_error) ? row.last_error : "UNKNOWN";
    codes[code] = (codes[code] ?? 0) + 1;
  }
  const count = Object.values(codes).reduce((a, b) => a + b, 0);
  return { check: "event-invalid", state: count ? "fail" : "pass", severity: "medium", category: "worker", source: "worker:event-invalid",
    summary: `${count} alarm job(s) could not be verified in the last 24 hours`, evidence: { codes } };
}

async function retryHeartbeat(sb: SupabaseClient, network: Network, now: number, signal: AbortSignal): Promise<Report | null> {
  const { data, error } = await sb.from("worker_heartbeats").select("last_ok_at").eq("network", network).eq("worker", "retry")
    .abortSignal(dbSignal(signal)).maybeSingle();
  if (error) return null;
  const at = (data as { last_ok_at?: string | null } | null)?.last_ok_at;
  const age = at ? Math.max(0, (now - Date.parse(at)) / 1000) : Number.POSITIVE_INFINITY;
  return { check: "worker-retry", state: thresholdState(age, RETRY_FAIL_SECONDS, RETRY_CLEAR_SECONDS), severity: "high",
    category: "worker", source: "worker:retry-heartbeat",
    summary: at ? `The retry worker last completed a run ${Math.round(age / 60)} minutes ago` : "The retry worker has not completed a run",
    evidence: { last_ok_seconds: Number.isFinite(age) ? Math.round(age) : null } };
}

/** The age after which a list still in use is an early warning (a daily job that missed a run). */
export const SANCTIONS_WARN_LIST_AGE_MS = 36 * 3_600_000;

/**
 * sanctions-list (8.5): the screening list the routes trust must be younger
 * than 3 days and not empty (lib/server/sanctions.ts). On mainnet the routes
 * refuse without it, so an unusable list is a high incident; a failed last
 * refresh or a list older than 36 hours is a medium one first (the routes
 * still work: time to fix the job). Elsewhere the screen only warns and the
 * check holds (nothing opens). Null when the state cannot be read (a check
 * that could not run).
 */
export async function sanctionsListReport(sb: SupabaseClient, network: Network, now: number, signal: AbortSignal): Promise<Report | null> {
  const { data, error } = await sb.from("sanctions_list_state")
    .select("refreshed_at,address_count,last_status,last_error,published_on,last_attempt_at")
    .eq("source", OFAC_SDN_SOURCE).abortSignal(dbSignal(signal)).maybeSingle();
  // Before 0078 is applied the table does not exist: that is "never loaded"
  // (fail on mainnet, hold elsewhere), not a check that could not run, so a
  // front deployed ahead of the migration does not turn every alarm run partial.
  const missing = error && ["42P01", "PGRST205"].includes((error as { code?: string }).code ?? "");
  if (error && !missing) return null;
  const row = (missing ? null : data ?? null) as {
    refreshed_at: string | null; address_count: number | null; last_status: string | null; last_error: string | null;
    published_on: string | null; last_attempt_at: string | null;
  } | null;
  const problem = listProblem(row ? { ...row } : null, row?.address_count ?? 0, now);
  const ageMs = row?.refreshed_at ? now - Date.parse(row.refreshed_at) : null;
  const ageHours = ageMs !== null && Number.isFinite(ageMs) ? Math.round(ageMs / 3_600_000) : null;
  // The early warning: still usable, but the refresh is failing or late.
  const lastFailed = row?.last_status === "failed";
  const late = ageMs !== null && ageMs > SANCTIONS_WARN_LIST_AGE_MS;
  const warning = !problem && (lastFailed || late);
  const hoursLeft = ageMs !== null ? Math.max(0, Math.round((SANCTIONS_MAX_LIST_AGE_MS - ageMs) / 3_600_000)) : null;
  const mainnet = network === "mainnet";
  return {
    check: "sanctions-list",
    state: !problem && !warning ? "pass" : mainnet ? "fail" : "hold",
    severity: !mainnet ? "low" : warning ? "medium" : "high",
    category: "worker", source: "worker:sanctions-list",
    summary: problem
      ? problem === "LIST_STALE"
        ? `The sanctions screening list was last refreshed ${ageHours} hours ago: screened routes refuse on mainnet`
        : "The sanctions screening list is not loaded: screened routes refuse on mainnet"
      : warning
        ? `The sanctions screening list ${lastFailed ? `did not refresh (last attempt failed: ${row?.last_error ?? "no code"})` : `was last refreshed ${ageHours} hours ago`}: screened routes refuse on mainnet in about ${hoursLeft} hours`
        : "The sanctions screening list is current",
    evidence: {
      problem, warning: warning ? (lastFailed ? "LAST_REFRESH_FAILED" : "LIST_LATE") : null,
      published_on: row?.published_on ?? null, age_hours: ageHours, address_count: row?.address_count ?? null,
      last_status: row?.last_status ?? null, last_error: row?.last_error ?? null,
    },
  };
}

/** Mirror rows of a pending role change (0079): unix-second strings or numbers. */
type Pending = { eta?: number | string | null; expires_at?: number | string | null; kind?: number | null };
const ROLE_CHANGE_TABLES = [
  ["pending_admins", "admin_grants", "Admin grant"],
  ["authority_proposals", "platform_rotations", "Super Admin rotation"],
  ["platform_recoveries", "platform_recoveries", "Super Admin recovery"],
  ["blocklist_recoveries", "blocklist_recoveries", "blocklist authority recovery"],
] as const;

/**
 * role-change-pending (0079, v1.0.0-rc D3/D4, high): the "timelock running"
 * incident. Open while the mirror holds a live (unexpired) staged Admin grant,
 * Super Admin rotation (AuthorityProposal kind 0), or upgrade-authority
 * recovery of the Super Admin or the blocklist authority: each exists so that
 * someone can veto it before it executes, and each instruction already raised
 * a critical alarm. It clears once none is live. [] before 0079 is applied
 * (nothing to watch); null when the mirror cannot be read.
 */
export async function roleChangesReport(sb: SupabaseClient, network: Network, now: number, signal: AbortSignal): Promise<Report[] | null> {
  const results = await Promise.all(ROLE_CHANGE_TABLES.map(([table]) =>
    sb.from(table).select(table === "authority_proposals" ? "kind,eta,expires_at" : "eta,expires_at")
      .eq("network", network).limit(1000).abortSignal(dbSignal(signal))));
  if (results.some((r) => r.error && missingRelation(r.error))) return [];
  if (results.some((r) => r.error)) return null;
  const nowSec = Math.floor(now / 1000);
  const seconds = (v: unknown) => (typeof v === "number" || (typeof v === "string" && /^-?\d+$/.test(v)) ? Number(v) : null);
  const counts: Record<string, number> = {};
  const parts: string[] = [];
  let nextEta: number | null = null;
  ROLE_CHANGE_TABLES.forEach(([table, key, label], i) => {
    const live = ((results[i].data ?? []) as Pending[]).filter((row) => {
      const expires = seconds(row.expires_at);
      // An unreadable expiry counts as live (the conservative side).
      return (expires === null || expires > nowSec) && (table !== "authority_proposals" || Number(row.kind) === 0);
    });
    counts[key] = live.length;
    if (live.length) parts.push(`${live.length} ${label}${live.length === 1 ? "" : "s"}`);
    for (const row of live) {
      const eta = seconds(row.eta);
      if (eta !== null && eta > nowSec && (nextEta === null || eta < nextEta)) nextEta = eta;
    }
  });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const when = nextEta === null ? null : `${new Date(nextEta * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return [{
    check: "role-change-pending", state: total ? "fail" : "pass", severity: "high", category: "onchain", source: "onchain:role-change-pending",
    summary: total
      ? `Role change pending (timelock running): ${parts.join(", ")}${when ? `; the next becomes executable at ${when}` : "; executable now"}. Cancel any you did not expect (/admin/admins, /admin/platform)`
      : "No role change is pending",
    evidence: { ...counts, next_eta: nextEta },
  }];
}

/**
 * payout-modules (D2, critical, mainnet only): the payout / Merkle modules bit
 * (0x40) of the mirrored Platform must stay SET on mainnet. The clear itself
 * is a critical instruction alarm; this incident stays open while the mirror
 * shows it clear. Elsewhere it passes (devnet may switch them on). Hold while
 * no Platform is mirrored; null when the mirror cannot be read.
 */
export async function payoutModulesReport(sb: SupabaseClient, network: Network, signal: AbortSignal): Promise<Report | null> {
  const base = { check: "payout-modules", severity: "critical" as const, category: "onchain" as const, source: "onchain:payout-modules" };
  if (network !== "mainnet") return { ...base, state: "pass", summary: "The payout modules may be switched on off mainnet" };
  const { data, error } = await sb.from("platforms").select("pause_flags").eq("network", network)
    .abortSignal(dbSignal(signal)).maybeSingle();
  if (error) return null;
  const flags = (data as { pause_flags?: number | null } | null)?.pause_flags;
  if (typeof flags !== "number") return { ...base, state: "hold", summary: "No Platform is mirrored yet" };
  const off = (flags & PAUSE_PAYOUT_MODULES) !== 0;
  return { ...base, state: off ? "pass" : "fail",
    summary: off ? "The payout modules are switched off (0x40 set)"
      : "The payout modules are switched ON on mainnet (0x40 clear): Startup raises, yield routing, Rights-Token issuances and milestones are open",
    evidence: { pause_flags: flags } };
}

/** Day D (runbook §0A, §4-§5) runs inside the bootstrap window: bootstrap-open fails once it is older than this (K1.11). */
export const BOOTSTRAP_WINDOW_MAX_HOURS = 72;

/**
 * bootstrap-open (D3, critical, mainnet only): bit 0x80 (the one-way
 * bootstrap window, which waives the 48 h of add_admin and of the Super
 * Admin rotation) must be closed on a live platform. v1 closes it with the
 * first clear of any pause bit, so bit 7 next to a clear emergency area means
 * an rc.x build unpaused (a rollback, runbook §10) and the platform came back
 * to v1 with the timelocks silently off. Fail while the mirror shows that.
 * Open with every emergency area paused is the bootstrap itself, which Day D
 * ends (S5c closes the window right after X1): it passes until the window is
 * BOOTSTRAP_WINDOW_MAX_HOURS old, then fails (a forgotten S5c, K1.11). The
 * window's age comes from the Platform's own state and the first indexed
 * transaction that touched it (initialize_platform), with no key: the other
 * half of chain:inventory's rule (bit 7 open once the final Super Admin holds
 * the platform) needs the role map, and the inventory keeps it. A window
 * whose first transaction is not indexed passes as before (the indexer's own
 * incidents report a mirror without events). Pass while bit 7 is closed; hold
 * while no Platform is mirrored; null when the mirror cannot be read.
 */
export async function bootstrapOpenReport(sb: SupabaseClient, network: Network, signal: AbortSignal, now = Date.now()): Promise<Report | null> {
  const base = { check: "bootstrap-open", severity: "critical" as const, category: "onchain" as const, source: "onchain:bootstrap-open" };
  if (network !== "mainnet") return { ...base, state: "pass", summary: "The bootstrap window is watched on mainnet only" };
  const { data, error } = await sb.from("platforms").select("pda,pause_flags").eq("network", network)
    .abortSignal(dbSignal(signal)).maybeSingle();
  if (error) return null;
  const platform = data as { pda?: string | null; pause_flags?: number | null } | null;
  const flags = platform?.pause_flags;
  if (typeof flags !== "number") return { ...base, state: "hold", summary: "No Platform is mirrored yet" };
  const open = (flags & PLATFORM_BOOTSTRAP_OPEN) !== 0;
  const unpaused = (flags & EMERGENCY_PAUSE_BITS) !== EMERGENCY_PAUSE_BITS;
  const close = 'The Super Admin closes it with set_pause_flags(0, 0x80) (/admin/platform, "Close bootstrap window")';
  if (open && unpaused) {
    return { ...base, state: "fail",
      summary: `The bootstrap window (bit 0x80) is open on a live platform (${formatPauseFlags(flags)}): add_admin and the Super Admin rotation skip their 48-hour timelock. ${close}`,
      evidence: { pause_flags: flags } };
  }
  if (!open) return { ...base, state: "pass", summary: "The bootstrap window is closed", evidence: { pause_flags: flags } };
  // The bootstrap: how long has the window been open?
  let openedAt: number | null = null;
  if (typeof platform?.pda === "string" && BASE58.test(platform.pda)) {
    const first = await sb.from("indexer_events").select("block_time,created_at").eq("network", network)
      .contains("wallets", [platform.pda]).order("created_at", { ascending: true }).limit(1)
      .abortSignal(dbSignal(signal)).maybeSingle();
    if (first.error) return null;
    const row = first.data as { block_time?: string | null; created_at?: string | null } | null;
    const at = Date.parse(row?.block_time ?? row?.created_at ?? "");
    openedAt = Number.isFinite(at) ? at : null;
  }
  const hours = openedAt === null ? null : Math.max(0, Math.floor((now - openedAt) / 3_600_000));
  if (openedAt !== null && hours !== null && hours >= BOOTSTRAP_WINDOW_MAX_HOURS) {
    return { ...base, state: "fail",
      summary: `The bootstrap window (bit 0x80) has been open for ${hours} hours (every area paused): Day D is over, yet add_admin and the Super Admin rotation still skip their 48-hour timelock. ${close} right after X1 (S5c)`,
      evidence: { pause_flags: flags, opened_at: new Date(openedAt).toISOString(), hours_open: hours, max_hours: BOOTSTRAP_WINDOW_MAX_HOURS } };
  }
  return { ...base, state: "pass",
    summary: openedAt === null
      ? "The bootstrap window is open while every emergency area is paused (bootstrap; its first transaction is not indexed)"
      : `The bootstrap window is open while every emergency area is paused (bootstrap, ${hours} of ${BOOTSTRAP_WINDOW_MAX_HOURS} hours)`,
    evidence: { pause_flags: flags, ...(openedAt === null ? {} : { opened_at: new Date(openedAt).toISOString(), hours_open: hours }) } };
}

type Hold = { subject: string; ref: string; code: string; payment_mint: string | null; created_at: string };
type FxRow = { payment_mint: string; kind: string; as_of: string; max_age: string; origin: FxOrigin };

/** fx-stale:<mint>, fx-missing:<mint> and capacity-holds; null when they could not be read. */
async function fxAndHolds(sb: SupabaseClient, network: Network, now: number, signal: AbortSignal): Promise<Report[] | null> {
  const [holdsRes, fxRes, autoRes, liveRes, openSalesRes, openIncidents] = await Promise.all([
    sb.from("sale_capacity_holds").select("subject,ref,code,payment_mint,created_at").eq("network", network).limit(500).abortSignal(dbSignal(signal)),
    sb.from("fx_rates").select("*").eq("network", network).abortSignal(dbSignal(signal)),
    sb.from("fx_auto_rates").select("payment_mint,eur_per_token,decimals,source,as_of,max_age").eq("network", network).abortSignal(dbSignal(signal)),
    sb.from("sale_capacity_reservations").select("payment_mint").eq("network", network).eq("kind", "sale")
      .in("status", ["reserved", "consumed"]).limit(1000).abortSignal(dbSignal(signal)),
    sb.from("sales").select("payment_mint").eq("network", network).eq("status", 0).limit(1000).abortSignal(dbSignal(signal)),
    sb.from("alarm_incidents").select("check_key").eq("network", network).is("cleared_at", null).not("last_fail_at", "is", null)
      .like("check_key", "fx-%").abortSignal(dbSignal(signal)),
  ]);
  if (holdsRes.error || fxRes.error || liveRes.error || openSalesRes.error) return null;
  // Before 0080 there is no automatic table: the manual rows alone count.
  if (autoRes.error && !tableMissing(autoRes.error)) return null;
  const holds = (holdsRes.data ?? []) as Hold[];
  // The rate that COUNTS per mint (0080, lib/fx-effective.ts): the automatic
  // one while fresh, else the manual row. `origin` tells them apart.
  const effective = resolveFxRates((fxRes.data ?? []) as FxManualRow[], autoRes.error ? [] : (autoRes.data ?? []) as FxAutoRow[], now);
  const rates = new Map<string, FxRow>([...effective].map(([mint, e]) =>
    [mint, { payment_mint: mint, kind: e.row.kind, as_of: e.row.as_of, max_age: e.row.max_age, origin: e.origin }]));
  const inUse = new Set<string>();
  for (const r of [...(liveRes.data ?? []), ...(openSalesRes.data ?? [])] as { payment_mint: string | null }[]) {
    if (r.payment_mint && BASE58.test(r.payment_mint)) inUse.add(r.payment_mint);
  }
  const revalue = new Set<string>();
  const missing = new Set<string>();
  for (const h of holds) {
    if (!h.payment_mint || !BASE58.test(h.payment_mint)) continue;
    inUse.add(h.payment_mint);
    if (h.code === "FX_REVALUE") revalue.add(h.payment_mint);
    if (h.code === "ADOPTION_PENDING") missing.add(h.payment_mint);
  }
  const reports: Report[] = [];
  const reported = new Set<string>();
  const stale = (r: FxRow) => {
    if (r.kind !== "rate") return false;
    const max = intervalSeconds(r.max_age);
    return max === null || now - Date.parse(r.as_of) >= max * 1000;
  };
  // fx-expiring: the mints in use plus the network's default payment mint.
  const expiryTracked = new Set(inUse);
  const defaultMint = defaultPaymentMint(network);
  if (defaultMint) expiryTracked.add(defaultMint);
  /** Milliseconds left before the row's max age; null for an eur_peg or unreadable row. */
  const left = (r: FxRow) => {
    const max = intervalSeconds(r.max_age);
    const asOf = Date.parse(r.as_of);
    // An automatic rate is renewed every minute; fxAutoReports watches it.
    if (r.kind !== "rate" || r.origin === "auto" || max === null || !Number.isFinite(asOf)) return null;
    return { ms: asOf + max * 1000 - now, window: Math.min(FX_EXPIRY_WARN_MS, (max * 1000) / 2) };
  };
  // Within the warning window and not yet expired (past the max age is fx-stale's).
  const expiring = (r: FxRow) => {
    const l = left(r);
    return l !== null && l.ms > 0 && l.ms <= l.window;
  };
  for (const mint of expiryTracked) {
    const row = rates.get(mint);
    const l = row ? left(row) : null;
    if (row && !l && row.origin === "auto") {
      // The automatic rate counts: nothing to refresh by hand.
      reports.push({ check: `fx-expiring:${mint}`, state: "pass", severity: "medium", category: "fx", source: "fx:expiring",
        summary: `The EUR rate of ${mint} is the automatic one`, evidence: { payment_mint: mint, as_of: row.as_of, origin: "auto" } });
      reported.add(`fx-expiring:${mint}`);
      continue;
    }
    if (!row || !l) continue;
    const hours = Math.max(0, Math.floor(l.ms / 3_600_000));
    reports.push({ check: `fx-expiring:${mint}`, state: expiring(row) ? "fail" : "pass", severity: "medium", category: "fx",
      source: "fx:expiring",
      summary: l.ms <= 0
        ? `The EUR rate of ${mint} is past its max age (reported as fx-stale while the mint is in use)`
        : `The EUR rate of ${mint} reaches its max age in ${hours} hour(s): refresh it on /admin/limits`,
      evidence: { payment_mint: mint, as_of: row.as_of, hours_left: hours } });
    reported.add(`fx-expiring:${mint}`);
  }
  for (const mint of inUse) {
    const row = rates.get(mint);
    if (row) {
      const isStale = stale(row);
      reports.push({ check: `fx-stale:${mint}`, state: isStale ? "fail" : "pass", severity: revalue.has(mint) ? "high" : "medium",
        category: "fx", source: "fx:stale",
        summary: `The EUR rate of ${mint} is past its max age while it is in use${revalue.has(mint) ? " (a value is on hold for revaluation)" : ""}`,
        evidence: { payment_mint: mint, as_of: row.as_of } });
      reported.add(`fx-stale:${mint}`);
    }
    if (missing.has(mint)) {
      reports.push({ check: `fx-missing:${mint}`, state: row ? "pass" : "fail", severity: "high", category: "fx", source: "fx:missing",
        summary: `An on-chain sale or mint paid in ${mint} cannot be counted: there is no EUR rate`, evidence: { payment_mint: mint } });
      reported.add(`fx-missing:${mint}`);
    }
  }
  // Earlier incidents whose mint is no longer held or in use: the condition is gone.
  if (!openIncidents.error) {
    for (const { check_key } of (openIncidents.data ?? []) as { check_key: string }[]) {
      const [kind, mint] = check_key.split(":");
      if (reported.has(check_key) || !mint || (kind !== "fx-stale" && kind !== "fx-missing" && kind !== "fx-expiring")) continue;
      const row = rates.get(mint);
      const gone = kind === "fx-missing" ? !!row || !missing.has(mint)
        : kind === "fx-expiring" ? !row || !expiring(row) || !expiryTracked.has(mint)
          : !row || !stale(row) || !inUse.has(mint);
      if (gone) {
        reports.push({ check: check_key, state: "pass", severity: kind === "fx-missing" ? "high" : "medium", category: "fx",
          source: kind === "fx-missing" ? "fx:missing" : kind === "fx-expiring" ? "fx:expiring" : "fx:stale",
          summary: `${kind} ${mint} recovered`, evidence: { payment_mint: mint } });
      }
    }
  }
  const old = holds.filter((h) => now - Date.parse(h.created_at) >= HOLD_FAIL_SECONDS * 1000);
  const byCode: Record<string, number> = {};
  for (const h of holds) byCode[h.code] = (byCode[h.code] ?? 0) + 1;
  reports.push({ check: "capacity-holds", state: !holds.length ? "pass" : old.length ? "fail" : "hold", severity: "high",
    category: "ledger", source: "ledger:capacity-holds",
    summary: `${holds.length} raise limit hold(s): new raises of those subjects are blocked`,
    evidence: { codes: byCode, subjects: [...new Set(holds.map((h) => h.subject))].slice(0, 20) } });
  return reports;
}

type FxObservation = { observed_at: string; status: string; code: string | null; eur_per_token: string | number | null; quotes: unknown };
const FX_AUTO_CHECKS = ["fx-auto-stale", "fx-fallback", "fx-source-down", "fx-depeg", "fx-divergence", "fx-jump"] as const;
type FxAutoCheck = (typeof FX_AUTO_CHECKS)[number];
const FX_AUTO_SEVERITY: Record<FxAutoCheck, Severity> = {
  "fx-auto-stale": "medium", "fx-fallback": "medium", "fx-source-down": "medium", "fx-depeg": "high", "fx-divergence": "medium",
  "fx-jump": "medium",
};
/** The refusals that are a verdict on the market (the sources answered, the prices were refused). */
const MARKET_REFUSALS: ReadonlySet<string> = new Set(["ECB_DEVIATION", "SOURCE_DIVERGENCE"]);

/**
 * The market verdicts since the last accepted run (newest first): the codes
 * of the refusals that judged the prices (ECB_DEVIATION, SOURCE_DIVERGENCE).
 * Other refusals (a source or the ECB not answering, the decimals) judged
 * nothing and are skipped, so they neither end nor extend the run of
 * verdicts; an accepted observation ends it. In a real depeg the books lag
 * each other, so the two codes alternate: they are judged together.
 */
export function marketRefusals(observations: readonly Pick<FxObservation, "status" | "code">[]): string[] {
  const codes: string[] = [];
  for (const o of observations) {
    if (o.status !== "refused") break;
    if (o.code && MARKET_REFUSALS.has(o.code)) codes.push(o.code);
  }
  return codes;
}

/** The market sources that answered in an observation (quotes.sources.<id>.rate). */
function answeredSources(quotes: unknown): Set<FxSourceId> {
  const sources = (quotes as { sources?: Record<string, unknown> } | null)?.sources;
  const answered = new Set<FxSourceId>();
  if (!sources || typeof sources !== "object") return answered;
  for (const { id } of FX_SOURCES) {
    const entry = sources[id] as { rate?: unknown } | undefined;
    if (entry && typeof entry.rate === "string") answered.add(id);
  }
  return answered;
}

/**
 * The automatic EUR rate of the network's USDC (0080, lib/fx-auto.ts);
 * null when it could not be read. Nothing is reported while the fx scheduler
 * has never run (no automatic row and no observation in the last hour), and
 * nothing before 0080 (the tables do not exist); earlier incidents then pass.
 *   fx-auto-stale   the automatic rate is past its max age (15 min): the
 *                   worker stopped or every run is refused. Medium while a
 *                   fresh manual rate covers it (it counts meanwhile), high
 *                   when nothing fresh is left.
 *   fx-fallback     while the automatic rate counts: the manual rate behind
 *                   it, the one that takes over when the automatic rate
 *                   stops, is past its max age or within the FX expiry
 *                   warning of it (medium), or missing (medium on mainnet,
 *                   where D10 keeps one; low elsewhere, never emailed). It
 *                   passes while the manual row counts itself (a peg, an
 *                   override, or the automatic rate is stale: fx-expiring,
 *                   fx-stale and fx-auto-stale judge it then).
 *   fx-source-down  a market source gave no usable answer for 15 minutes
 *                   while the worker kept running (redundancy is reduced).
 *   fx-depeg        the newest FX_REFUSAL_STREAK market verdicts since the
 *                   last accepted run (marketRefusals) were all refusals and
 *                   at least one of them found the sources' median > 2 %
 *                   away from the ECB rate (a USDC depeg, or broken
 *                   sources); high. Fewer verdicts: hold.
 *   fx-divergence   the same verdicts, all of them sources that disagree by
 *                   > 1 % (a broken source or a disorderly market); medium.
 *                   Mixed with an ECB deviation it holds: fx-depeg reports it.
 *   fx-jump         the accepted rates of the last hour moved more than
 *                   FX_JUMP_THRESHOLD (1 %); hold above half of it.
 */
export async function fxAutoReports(sb: SupabaseClient, network: Network, now: number, signal: AbortSignal): Promise<Report[] | null> {
  const mint = autoFxMint(network);
  const since = new Date(now - FX_JUMP_WINDOW_MS).toISOString();
  const openRes = await sb.from("alarm_incidents").select("check_key").eq("network", network).is("cleared_at", null)
    .not("last_fail_at", "is", null).like("check_key", "fx-%").abortSignal(dbSignal(signal));
  const open = openRes.error ? [] : ((openRes.data ?? []) as { check_key: string }[]).map((r) => r.check_key)
    .filter((key) => (FX_AUTO_CHECKS as readonly string[]).includes(key.split(":")[0]));
  const reports: Report[] = [];
  /** Earlier incidents not reported in this run: their condition is gone. */
  const passOpen = (reported: Set<string>) => {
    for (const key of open) {
      if (reported.has(key)) continue;
      const kind = key.split(":")[0] as FxAutoCheck;
      reports.push({ check: key, state: "pass", severity: FX_AUTO_SEVERITY[kind], category: "fx", source: `fx:${kind.slice(3)}`,
        summary: `${kind} recovered`, evidence: {} });
    }
    return reports;
  };
  if (!mint) return passOpen(new Set());
  const [autoRes, manualRes, obsRes] = await Promise.all([
    sb.from("fx_auto_rates").select("payment_mint,eur_per_token,decimals,source,as_of,max_age")
      .eq("network", network).eq("payment_mint", mint).abortSignal(dbSignal(signal)).maybeSingle(),
    sb.from("fx_rates").select("*").eq("network", network).eq("payment_mint", mint).abortSignal(dbSignal(signal)).maybeSingle(),
    sb.from("fx_rate_observations").select("observed_at,status,code,eur_per_token,quotes")
      .eq("network", network).eq("payment_mint", mint).gte("observed_at", since)
      .order("observed_at", { ascending: false }).limit(200).abortSignal(dbSignal(signal)),
  ]);
  if (autoRes.error || obsRes.error) {
    // Before 0080: nothing to watch.
    if (tableMissing(autoRes.error) || tableMissing(obsRes.error)) return passOpen(new Set());
    return null;
  }
  if (manualRes.error) return null;
  const auto = (autoRes.data ?? null) as FxAutoRow | null;
  const manual = (manualRes.data ?? null) as FxManualRow | null;
  const observations = ((obsRes.data ?? []) as FxObservation[])
    .filter((o) => Number.isFinite(Date.parse(o.observed_at)))
    .sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at));
  if (!auto && observations.length === 0) return passOpen(new Set());

  const label = paymentMintLabel(mint, network);
  const reported = new Set<string>();
  const push = (r: Report) => {
    reports.push(r);
    reported.add(r.check);
  };
  const latest = observations[0] ?? null;
  const lastCode = observations.find((o) => o.status === "refused")?.code ?? null;

  // fx-auto-stale
  const autoFresh = auto !== null && fxRowFresh({ kind: "rate", as_of: auto.as_of, max_age: auto.max_age }, now);
  const fallback = manual !== null && (manual.kind === "eur_peg" || fxRowFresh(manual, now));
  const ageMinutes = auto ? Math.max(0, Math.floor((now - Date.parse(auto.as_of)) / 60_000)) : null;
  const why = latest?.status === "refused" ? ` (runs refused: ${latest.code})` : latest ? "" : " (the fx job has not run in the last hour)";
  push({ check: `fx-auto-stale:${mint}`, state: autoFresh ? "pass" : "fail", severity: !autoFresh && !fallback ? "high" : "medium",
    category: "fx", source: "fx:auto-stale",
    summary: autoFresh
      ? `The automatic EUR rate of ${label} is current`
      : `The automatic EUR rate of ${label} is ${ageMinutes === null ? "missing" : `${ageMinutes} minute(s) old`}${why}; ${
        fallback ? "the manual rate on /admin/limits counts meanwhile" : "no fresh manual rate covers it"}`,
    evidence: { payment_mint: mint, as_of: auto?.as_of ?? null, age_minutes: ageMinutes, last_refusal: lastCode,
      latest_status: latest?.status ?? null, manual_fallback: fallback } });

  // fx-fallback: the manual rate behind a fresh automatic one.
  const fallbackCheck = `fx-fallback:${mint}`;
  if (!autoFresh || (manual !== null && (manual.kind === "eur_peg" || manual.override_auto))) {
    push({ check: fallbackCheck, state: "pass", severity: "medium", category: "fx", source: "fx:fallback",
      summary: autoFresh
        ? `The manual EUR rate of ${label} counts by itself`
        : `The manual EUR rate of ${label} counts now (the automatic one is out of date)`,
      evidence: { payment_mint: mint, auto_fresh: autoFresh } });
  } else if (manual === null) {
    push({ check: fallbackCheck, state: "fail", severity: network === "mainnet" ? "medium" : "low", category: "fx",
      source: "fx:fallback",
      summary: `No manual EUR rate of ${label} backs the automatic one: if the automatic rate stops, sale approvals stop once it `
        + "is out of date. Enter one on /admin/limits",
      evidence: { payment_mint: mint, manual: null } });
  } else {
    const max = intervalSeconds(manual.max_age);
    const asOf = Date.parse(manual.as_of);
    const leftMs = max === null || !Number.isFinite(asOf) ? null : asOf + max * 1000 - now;
    const window = max === null ? FX_EXPIRY_WARN_MS : Math.min(FX_EXPIRY_WARN_MS, (max * 1000) / 2);
    const hours = leftMs === null ? null : Math.max(0, Math.floor(leftMs / 3_600_000));
    push({ check: fallbackCheck, state: leftMs === null || leftMs <= window ? "fail" : "pass", severity: "medium", category: "fx",
      source: "fx:fallback",
      summary: leftMs === null || leftMs <= 0
        ? `The manual EUR rate of ${label} behind the automatic one is past its max age: if the automatic rate stops, `
          + "sale approvals stop. Refresh it on /admin/limits"
        : `The manual EUR rate of ${label} behind the automatic one reaches its max age in ${hours} hour(s): refresh it on /admin/limits`,
      evidence: { payment_mint: mint, as_of: manual.as_of, hours_left: hours } });
  }

  // fx-source-down: only while the worker runs and has covered the window.
  const recent = latest !== null && now - Date.parse(latest.observed_at) < 5 * 60_000;
  const covered = observations.length > 0 && now - Date.parse(observations[observations.length - 1].observed_at) >= FX_SOURCE_DOWN_MS;
  if (recent && covered) {
    const lastOk: Partial<Record<FxSourceId, string>> = {};
    for (const o of observations) {
      for (const id of answeredSources(o.quotes)) lastOk[id] ??= o.observed_at;
    }
    const down = FX_SOURCES.map((s) => s.id).filter((id) => {
      const at = lastOk[id];
      return at === undefined || now - Date.parse(at) >= FX_SOURCE_DOWN_MS;
    });
    push({ check: `fx-source-down:${mint}`, state: down.length ? "fail" : "pass", severity: "medium", category: "fx",
      source: "fx:source-down",
      summary: down.length
        ? `EUR rate source(s) without a usable answer for ${FX_SOURCE_DOWN_MS / 60_000} minutes: ${down.join(", ")}`
        : "Every EUR rate source answers",
      evidence: { payment_mint: mint, down, last_ok: lastOk } });
  }

  // fx-depeg and fx-divergence: the market verdicts since the last accepted run.
  const verdicts = marketRefusals(observations);
  const newest = verdicts.slice(0, FX_REFUSAL_STREAK);
  const full = newest.length >= FX_REFUSAL_STREAK;
  const deviated = newest.includes("ECB_DEVIATION");
  const diverged = newest.includes("SOURCE_DIVERGENCE");
  // The newest market verdict's evidence since the last accepted run (another refusal carries no judged prices).
  const lastAccepted = observations.findIndex((o) => o.status !== "refused");
  const verdictObs = observations.slice(0, lastAccepted === -1 ? observations.length : lastAccepted)
    .find((o) => o.code !== null && MARKET_REFUSALS.has(o.code)) ?? latest;
  const verdictQuotes = (verdictObs?.quotes ?? {}) as Record<string, unknown>;
  const states: Record<"fx-depeg" | "fx-divergence", Report["state"]> = {
    "fx-depeg": deviated ? (full ? "fail" : "hold") : "pass",
    "fx-divergence": diverged ? (full && !deviated ? "fail" : "hold") : "pass",
  };
  for (const [check, code, seen] of [["fx-depeg", "ECB_DEVIATION", deviated], ["fx-divergence", "SOURCE_DIVERGENCE", diverged]] as const) {
    const what = check === "fx-depeg"
      ? `the ${label}/EUR market median is more than 2 % away from the ECB reference rate (USDC depeg or broken sources)`
      : `the ${label}/EUR sources disagree by more than 1 % (a broken source?)`;
    const times = newest.filter((c) => c === code).length;
    push({ check: `${check}:${mint}`, state: states[check],
      severity: FX_AUTO_SEVERITY[check], category: "fx", source: `fx:${check.slice(3)}`,
      summary: seen
        ? `${what}; ${verdicts.length} run(s) refused on the prices since the last accepted one (${times} of the newest ${newest.length})`
        : `The ${label}/EUR sources agree with each other and with the ECB`,
      evidence: { payment_mint: mint, refused_in_a_row: verdicts.length, recent_codes: newest, median: verdictQuotes.median ?? null,
        spread_bps: verdictQuotes.spread_bps ?? null, ecb: verdictQuotes.ecb ?? null,
        ecb_deviation_bps: verdictQuotes.ecb_deviation_bps ?? null, sources: verdictQuotes.sources ?? null } });
  }

  // fx-jump: the accepted rates of the last hour.
  const accepted = observations.filter((o) => o.status === "accepted").map((o) => Number(o.eur_per_token))
    .filter((r) => Number.isFinite(r) && r > 0);
  const low = accepted.length ? Math.min(...accepted) : null;
  const high = accepted.length ? Math.max(...accepted) : null;
  const move = low !== null && high !== null && accepted.length >= 2 ? (high - low) / low : 0;
  push({ check: `fx-jump:${mint}`, state: thresholdState(move, FX_JUMP_THRESHOLD, FX_JUMP_THRESHOLD / 2), severity: "medium",
    category: "fx", source: "fx:jump",
    summary: `The automatic ${label}/EUR rate moved ${(move * 100).toFixed(2)} % within ${FX_JUMP_WINDOW_MS / 60_000} minutes`,
    evidence: { payment_mint: mint, move_bps: Math.round(move * 10_000), min: low, max: high, accepted_runs: accepted.length } });

  return passOpen(reported);
}

/**
 * Whether a finalized transaction invokes a watched program (top-level or
 * inner): asset_registry, transfer_hook, or a loader instruction on one of
 * our programs (upgradeable loader on its ProgramData, loader-v4 on the
 * program). Only those are delivered by the webhook and matter to the alarms.
 * An undecodable transaction, or one without its status meta (so its CPIs
 * cannot be seen), counts as watched (conservative).
 */
export function invokesWatchedProgram(tx: InvocationTx, pd: ProgramDataAddresses): boolean {
  let invocations;
  try {
    // No status meta (inner instructions, loaded keys): a CPI could be hidden.
    if (!hasInvocationMeta(tx)) return true;
    invocations = flattenInvocations(tx);
  } catch {
    return true;
  }
  const programData = new Set([pd.assetRegistry, pd.transferHook]);
  const programs = new Set<string>([ASSET_REGISTRY_PROGRAM_ADDRESS, TRANSFER_HOOK_PROGRAM_ADDRESS]);
  return invocations.some((inv) => programs.has(inv.programId)
    || (inv.programId === BPF_LOADER_UPGRADEABLE && programData.has(inv.accounts[0]))
    || (inv.programId === LOADER_V4 && programs.has(inv.accounts[0])));
}

/**
 * Gap scan of the watched addresses; repairs up to GAP_REPAIR_MAX missing
 * transactions. `missing` counts the missing transactions that invoke a
 * watched program, plus those not fetched this run (unknown: counted);
 * `ignored` the ones that invoke none (never enqueued). The transfer_hook
 * program ID is paged last, on GAP_SCAN_HOOK_PAGES, into `hookComplete`.
 */
export async function gapScan(sb: SupabaseClient, network: Network, now: number, signal: AbortSignal): Promise<GapScanResult> {
  const pd = await programDataAddresses();
  const [blocklistAuthority] = await findBlocklistAuthorityPda();
  const addresses = [ASSET_REGISTRY_PROGRAM_ADDRESS, blocklistAuthority, pd.assetRegistry, pd.transferHook];
  const from = Math.floor((now - GAP_WINDOW.fromMs) / 1000);
  const to = Math.floor((now - GAP_WINDOW.toMs) / 1000);
  const seen = new Map<string, number>();
  let complete = true;
  for (const account of addresses) {
    const listed = await listFinalizedSignatures(account, from, to, signal, GAP_SCAN_PAGES);
    if (!listed.complete) complete = false;
    for (const s of listed.signatures) seen.set(s.signature, s.blockTime);
  }
  // Last, on its own budget: every hooked transfer lists the hook program ID.
  const hook = await listFinalizedSignatures(TRANSFER_HOOK_PROGRAM_ADDRESS, from, to, signal, GAP_SCAN_HOOK_PAGES);
  for (const s of hook.signatures) seen.set(s.signature, s.blockTime);
  const signatures = [...seen.keys()];
  const known = new Set<string>();
  for (let i = 0; i < signatures.length; i += 100) {
    const { data, error } = await sb.from("indexer_events").select("signature").eq("network", network)
      .in("signature", signatures.slice(i, i + 100)).abortSignal(dbSignal(signal));
    if (error) throw new Error("Indexer events unavailable");
    for (const row of (data ?? []) as { signature: string }[]) known.add(row.signature);
  }
  const candidates = signatures.filter((s) => !known.has(s));
  let missing = Math.max(0, candidates.length - GAP_REPAIR_MAX);
  let repaired = 0;
  let ignored = 0;
  for (const [i, sig] of candidates.slice(0, GAP_REPAIR_MAX).entries()) {
    if (signal.aborted) {
      // Not verified this run: counted as missing.
      missing += Math.min(GAP_REPAIR_MAX, candidates.length) - i;
      break;
    }
    const tx = (await finalizedTransaction(sig, signal)) as (InvocationTx & { slot?: number | bigint }) | null;
    if (!tx) {
      missing++;
      continue;
    }
    if (!invokesWatchedProgram(tx, pd)) {
      ignored++;
      continue;
    }
    missing++;
    const wallets = [...new Set(resolveAccountKeys(tx))].filter((k) => BASE58.test(k)).slice(0, 500);
    const blockTime = tx.blockTime ?? seen.get(sig) ?? null;
    const { error } = await sb.rpc("enqueue_indexer_events", {
      p_network: network,
      p_events: [{
        signature: sig, slot: tx.slot === undefined ? null : Number(tx.slot),
        block_time: blockTime === null ? null : new Date(Number(blockTime) * 1000).toISOString(),
        ix_name: "GAP_SCAN", wallets, payload: { source: "gap-scan" },
      }],
    }).abortSignal(dbSignal(signal));
    if (!error) repaired++;
  }
  return { missing, repaired, ignored, complete, hookComplete: hook.complete };
}

/** When the last gap scan started (the alarms heartbeat), or unknown on a read error. */
type GapStamp = { known: true; at: number | null } | { known: false };

async function lastGapScan(sb: SupabaseClient, network: Network, signal: AbortSignal): Promise<GapStamp> {
  const { data, error } = await sb.from("worker_heartbeats").select("last_gap_scan_at").eq("network", network).eq("worker", "alarms")
    .abortSignal(dbSignal(signal)).maybeSingle();
  if (error) return { known: false };
  const raw = (data as { last_gap_scan_at?: string | null } | null)?.last_gap_scan_at;
  const at = raw ? Date.parse(raw) : NaN;
  // An unreadable stamp counts as never: the scan is due, not skipped forever.
  return { known: true, at: Number.isFinite(at) ? at : null };
}

/** Whether a gap scan is due (none started, or the last ≥ 5 min ago). */
export function gapScanDue(at: number | null, now: number): boolean {
  return at === null || now - at >= GAP_SCAN_EVERY_MS;
}

/**
 * gap-scan-overdue: pass when a scan started in this run or none is due yet;
 * fail when none has started for GAP_SCAN_OVERDUE_MS; hold in between, and
 * while no scan has ever started (the first run that has time decides).
 */
export function gapScanOverdueState(at: number | null, ranNow: boolean, now: number): IncidentState {
  if (ranNow) return "pass";
  if (at === null) return "hold";
  if (now - at >= GAP_SCAN_OVERDUE_MS) return "fail";
  return gapScanDue(at, now) ? "hold" : "pass";
}

/**
 * The last gap scan's stamp; the cheap checks, recorded at once; then the gap
 * scan (when due) under its own sub-deadline, and its incidents plus
 * gap-scan-overdue, with the operational watches running beside it. Never throws: `expected` against `reports.length` tells
 * the worker whether the stage was complete (a due scan that got no time, or
 * an unreadable stamp, is a check that could not run).
 */
export async function runAlarmChecks(sb: SupabaseClient, deadlineMs: number, signal: AbortSignal): Promise<ChecksResult> {
  const network = detectNetwork();
  const now = Date.now();
  const done: CheckReport[] = [];
  let expected = 0;
  const record = async (reports: readonly Report[]) => {
    expected += reports.length;
    for (const r of reports) {
      if (signal.aborted) return;
      try {
        await reportIncident(sb, {
          network, check: r.check, state: r.state, category: r.category, source: r.source, severity: r.severity,
          summary: r.summary, evidence: r.evidence, notify: true,
        }, signal);
        done.push({ check: r.check, state: r.state, severity: r.severity });
      } catch {
        console.error(`[alarms] incident ${r.check} not recorded`);
      }
    }
  };

  // 0. When the last gap scan started: one row, read before the cheap checks
  // so a due scan is known however long they take.
  let stamp: GapStamp = { known: false };
  if (!signal.aborted && Date.now() < deadlineMs) {
    try {
      stamp = await lastGapScan(sb, network, signal);
    } catch {
      stamp = { known: false };
    }
  }
  const due = stamp.known && gapScanDue(stamp.at, now);

  // 1. The cheap checks. One that cannot run (error, timeout, deadline) is a miss.
  const cheap: Report[] = [];
  const collect = async (work: () => Promise<Report | Report[] | null>) => {
    if (signal.aborted || Date.now() >= deadlineMs) {
      expected++;
      return;
    }
    try {
      const r = await work();
      if (r === null) expected++;
      else if (Array.isArray(r)) cheap.push(...r);
      else cheap.push(r);
    } catch {
      expected++;
      console.error("[alarms] a check could not run");
    }
  };
  for (const table of ["indexer_jobs", "onchain_event_jobs", "spv_issuance_jobs"] as const) {
    await collect(() => queueReport(sb, network, now, table));
  }
  await collect(() => indexerDegraded(sb, network, now, signal));
  await collect(() => eventInvalid(sb, network, now, signal));
  await collect(() => retryHeartbeat(sb, network, now, signal));
  await collect(() => fxAndHolds(sb, network, now, signal));
  await collect(() => fxAutoReports(sb, network, now, signal));
  await collect(() => indexerFreshness(sb, network, now, signal));
  await collect(() => sanctionsListReport(sb, network, now, signal));
  await collect(() => roleChangesReport(sb, network, now, signal));
  await collect(() => payoutModulesReport(sb, network, signal));
  await collect(() => bootstrapOpenReport(sb, network, signal, now));
  await record(cheap);

  // 2. The operational watches (chain reads), in parallel with the gap scan,
  // on their own budget; their incidents are recorded as soon as they finish.
  const gapDeadline = deadlineMs - GAP_SCAN_RESERVE_MS;
  const opsWatch = (async () => {
    const budget = Math.min(OPS_WATCH_BUDGET_MS, deadlineMs - OPS_WATCH_RESERVE_MS - Date.now());
    if (signal.aborted || budget <= 0) {
      expected++;
      return;
    }
    let watches: Report[];
    try {
      watches = await opsWatchReports(sb, network, AbortSignal.any([signal, AbortSignal.timeout(budget)]));
    } catch {
      expected++;
      console.error("[alarms] the operational watches could not run");
      return;
    }
    await record(watches);
  })();

  // 3. The gap scan, in what is left minus the reserve for its own incidents.
  let gap: ChecksResult["gapScan"] = null;
  const reports: Report[] = [];
  if (due && !signal.aborted && Date.now() < gapDeadline) {
    const gapSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, gapDeadline - Date.now()))]);
    let result: GapScanResult | null = null;
    try {
      result = await gapScan(sb, network, now, gapSignal);
    } catch {
      console.error("[alarms] gap scan failed or ran out of time");
    }
    const cutShort = result === null || gapSignal.aborted;
    gap = { ran: true, cutShort, ...(result ?? { missing: 0, repaired: 0, ignored: 0, complete: false, hookComplete: false }) };
    if (result) {
      reports.push({ check: "indexer-gap", state: result.missing ? "fail" : cutShort ? "hold" : "pass", severity: "high",
        category: "indexer", source: "indexer:gap",
        summary: `${result.missing} finalized program transaction(s) were missing from the index (${result.repaired} re-queued)`,
        evidence: { missing: result.missing, repaired: result.repaired, ignored: result.ignored } });
    }
    const incomplete = cutShort || !result?.complete;
    reports.push({ check: "gap-scan-incomplete", state: incomplete ? "fail" : "pass", severity: "medium", category: "indexer",
      source: "indexer:gap-scan-incomplete",
      summary: cutShort ? "The gap scan could not finish within its time budget" : "The gap scan ran out of pages before the start of its window",
      evidence: { window_minutes: [GAP_WINDOW.fromMs / 60_000, GAP_WINDOW.toMs / 60_000], cut_short: cutShort,
        hook_complete: result ? result.hookComplete : null } });
  } else if (!stamp.known) {
    // Whether a scan was due could not be read: a check that could not run.
    expected++;
    console.error("[alarms] could not tell whether a gap scan was due");
  } else if (due) {
    // Due, but the cheap checks left no time for it: a check that could not
    // run (the stage is partial), retried next minute; gap-scan-overdue below.
    expected++;
    console.error("[alarms] a due gap scan got no time in this run");
  }
  if (stamp.known) {
    const state = gapScanOverdueState(stamp.at, gap !== null, now);
    const minutes = stamp.at === null ? null : Math.floor((now - stamp.at) / 60_000);
    reports.unshift({ check: "gap-scan-overdue", state, severity: "high", category: "indexer", source: "indexer:gap-scan-overdue",
      summary: minutes === null ? "No gap scan has started yet" : `The last gap scan started ${minutes} minute(s) ago`,
      evidence: { minutes_since_last_scan: minutes, overdue_after_minutes: GAP_SCAN_OVERDUE_MS / 60_000, ran_now: gap !== null } });
  }
  await Promise.all([record(reports), opsWatch]);
  return { reports: done, expected, gapScan: gap };
}
