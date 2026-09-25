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
// the five watched addresses (both program IDs, the blocklist-authority PDA,
// both ProgramData PDAs) in [now − 20 min, now − 5 min]; any missing from
// indexer_events is fetched (finalized) and, when it invokes a watched
// program, enqueued through the indexer's own path (enqueue_indexer_events),
// which repairs the mirror, and whose 0072 trigger creates the alarm job
// (source gap-scan). A listed transaction that invokes none of them (anyone
// can list the blocklist-authority PDA or a program ID as a read-only
// account; the webhook never delivers the PDA ones) is ignored: not missing,
// not enqueued. Only public account keys and {"source":"gap-scan"} are written.
// The transfer_hook program ID is listed so that a missed hook-only
// transaction is repaired too: the freshness heartbeat (0075) requires every
// successful transaction of both programs to be indexed.
//
// indexer-freshness (0075): how long the mirror has gone without being
// proven in sync, from the newer of indexer_sync_state.checked_at (jobs and
// reconciles keep it fresh while the network is busy) and the heartbeat's
// last proof. Pass while the heartbeat is off, hold while the indexer is not
// ready (indexer-degraded reports that) or the heartbeat never ran; low
// severity in observe mode (never emailed), medium in on. Before 0075 is
// applied it reports nothing.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ASSET_REGISTRY_PROGRAM_ADDRESS } from "@/lib/generated/asset_registry";
import { TRANSFER_HOOK_PROGRAM_ADDRESS, findBlocklistAuthorityPda } from "@/lib/generated/transfer_hook";
import { detectNetwork, type Network } from "@/lib/network";
import { QUEUE_FAIL_SECONDS, QUEUE_WARN_SECONDS, checkQueue, intervalSeconds, type QueueTable } from "@/lib/server/health";
import { BPF_LOADER_UPGRADEABLE, LOADER_V4, programDataAddresses, type ProgramDataAddresses } from "@/lib/server/onchain-alarms";
import { finalizedTransaction, listFinalizedSignatures } from "@/lib/server/sale-capacity-chain";
import { reportIncident, type AlertCategory, type IncidentState, type Severity } from "@/lib/server/system-alerts";
import { flattenInvocations, resolveAccountKeys, type InvocationTx } from "@/lib/server/tx-invocations";

export const GAP_SCAN_EVERY_MS = 5 * 60_000;
export const GAP_WINDOW = { fromMs: 20 * 60_000, toMs: 5 * 60_000 } as const;
export const GAP_SCAN_PAGES = 5;
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
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type CheckReport = { check: string; state: IncidentState; severity: Severity };
export type GapScanResult = { missing: number; repaired: number; ignored: number; complete: boolean };
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

/** indexer-freshness; [] before 0075 is applied (nothing to watch), null when it could not be read. */
async function indexerFreshness(sb: SupabaseClient, network: Network, now: number, signal: AbortSignal): Promise<Report[] | null> {
  const [hbRes, syncRes] = await Promise.all([
    sb.from("indexer_heartbeat_state").select("mode,last_attempt_at,last_proven_at,last_reason").eq("network", network)
      .abortSignal(dbSignal(signal)).maybeSingle(),
    sb.from("indexer_sync_state").select("status,checked_at,completed_at").eq("network", network)
      .abortSignal(dbSignal(signal)).maybeSingle(),
  ]);
  if (hbRes.error && missingRelation(hbRes.error)) return [];
  if (hbRes.error || syncRes.error) return null;
  type Heartbeat = { mode?: string; last_attempt_at?: string | null; last_proven_at?: string | null; last_reason?: string | null };
  const hb = hbRes.data as Heartbeat | null;
  const sync = syncRes.data as { status?: string; checked_at?: string | null; completed_at?: string | null } | null;
  const mode = hb?.mode ?? null;
  const reason = hb?.last_reason && /^[A-Z_]{1,40}$/.test(hb.last_reason) ? hb.last_reason : null;
  const base = {
    check: "indexer-freshness", category: "indexer" as const, source: "indexer:freshness",
    severity: (mode === "on" ? "medium" : "low") as Severity,
  };
  if (mode === "off") return [{ ...base, state: "pass", summary: "The indexer freshness heartbeat is off", evidence: { mode } }];
  if (!hb || !hb.last_attempt_at) {
    return [{ ...base, state: "hold", summary: "The indexer freshness heartbeat has not run yet", evidence: { mode } }];
  }
  if (sync?.status !== "ready" || !sync.completed_at) {
    return [{ ...base, state: "hold", summary: "The indexer is not ready, so the heartbeat cannot prove it", evidence: { mode, reason } }];
  }
  const proven = Math.max(Date.parse(sync.checked_at ?? ""), Date.parse(hb.last_proven_at ?? ""));
  const age = Number.isFinite(proven) ? Math.max(0, (now - proven) / 1000) : Number.POSITIVE_INFINITY;
  const minutes = Number.isFinite(age) ? Math.floor(age / 60) : null;
  const summary = minutes === null
    ? "The indexer mirror has never been proven in sync; the site reads the chain"
    : `The indexer mirror was last proven in sync ${minutes} minute(s) ago${reason ? ` (heartbeat: ${reason})` : ""}; the site reads the chain`;
  return [{ ...base, state: thresholdState(age, FRESHNESS_FAIL_SECONDS, FRESHNESS_CLEAR_SECONDS), summary,
    evidence: { mode, reason, minutes_since_proof: minutes } }];
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

type Hold = { subject: string; ref: string; code: string; payment_mint: string | null; created_at: string };
type FxRow = { payment_mint: string; kind: string; as_of: string; max_age: string };

/** fx-stale:<mint>, fx-missing:<mint> and capacity-holds; null when they could not be read. */
async function fxAndHolds(sb: SupabaseClient, network: Network, now: number, signal: AbortSignal): Promise<Report[] | null> {
  const [holdsRes, fxRes, liveRes, openSalesRes, openIncidents] = await Promise.all([
    sb.from("sale_capacity_holds").select("subject,ref,code,payment_mint,created_at").eq("network", network).limit(500).abortSignal(dbSignal(signal)),
    sb.from("fx_rates").select("payment_mint,kind,as_of,max_age").eq("network", network).abortSignal(dbSignal(signal)),
    sb.from("sale_capacity_reservations").select("payment_mint").eq("network", network).eq("kind", "sale")
      .in("status", ["reserved", "consumed"]).limit(1000).abortSignal(dbSignal(signal)),
    sb.from("sales").select("payment_mint").eq("network", network).eq("status", 0).limit(1000).abortSignal(dbSignal(signal)),
    sb.from("alarm_incidents").select("check_key").eq("network", network).is("cleared_at", null).not("last_fail_at", "is", null)
      .like("check_key", "fx-%").abortSignal(dbSignal(signal)),
  ]);
  if (holdsRes.error || fxRes.error || liveRes.error || openSalesRes.error) return null;
  const holds = (holdsRes.data ?? []) as Hold[];
  const rates = new Map(((fxRes.data ?? []) as FxRow[]).map((r) => [r.payment_mint, r]));
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
      if (reported.has(check_key) || !mint || (kind !== "fx-stale" && kind !== "fx-missing")) continue;
      const row = rates.get(mint);
      const gone = kind === "fx-missing" ? !!row || !missing.has(mint) : !row || !stale(row) || !inUse.has(mint);
      if (gone) {
        reports.push({ check: check_key, state: "pass", severity: kind === "fx-missing" ? "high" : "medium", category: "fx",
          source: kind === "fx-missing" ? "fx:missing" : "fx:stale", summary: `${kind} ${mint} recovered`, evidence: { payment_mint: mint } });
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

/**
 * Whether a finalized transaction invokes a watched program (top-level or
 * inner): asset_registry, transfer_hook, or a loader instruction on one of
 * our programs (upgradeable loader on its ProgramData, loader-v4 on the
 * program). Only those are delivered by the webhook and matter to the alarms.
 * An undecodable transaction counts as watched (conservative).
 */
export function invokesWatchedProgram(tx: InvocationTx, pd: ProgramDataAddresses): boolean {
  let invocations;
  try {
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
 * Gap scan of the five watched addresses; repairs up to GAP_REPAIR_MAX missing
 * transactions. `missing` counts the missing transactions that invoke a
 * watched program, plus those not fetched this run (unknown: counted);
 * `ignored` the ones that invoke none (never enqueued).
 */
export async function gapScan(sb: SupabaseClient, network: Network, now: number, signal: AbortSignal): Promise<GapScanResult> {
  const pd = await programDataAddresses();
  const [blocklistAuthority] = await findBlocklistAuthorityPda();
  const addresses = [ASSET_REGISTRY_PROGRAM_ADDRESS, TRANSFER_HOOK_PROGRAM_ADDRESS, blocklistAuthority, pd.assetRegistry, pd.transferHook];
  const from = Math.floor((now - GAP_WINDOW.fromMs) / 1000);
  const to = Math.floor((now - GAP_WINDOW.toMs) / 1000);
  const seen = new Map<string, number>();
  let complete = true;
  for (const account of addresses) {
    const listed = await listFinalizedSignatures(account, from, to, signal, GAP_SCAN_PAGES);
    if (!listed.complete) complete = false;
    for (const s of listed.signatures) seen.set(s.signature, s.blockTime);
  }
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
  return { missing, repaired, ignored, complete };
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
 * gap-scan-overdue. Never throws: `expected` against `reports.length` tells
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
  await collect(() => indexerFreshness(sb, network, now, signal));
  await record(cheap);

  // 2. The gap scan, in what is left minus the reserve for its own incidents.
  let gap: ChecksResult["gapScan"] = null;
  const gapDeadline = deadlineMs - GAP_SCAN_RESERVE_MS;
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
    gap = { ran: true, cutShort, ...(result ?? { missing: 0, repaired: 0, ignored: 0, complete: false }) };
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
      evidence: { window_minutes: [GAP_WINDOW.fromMs / 60_000, GAP_WINDOW.toMs / 60_000], cut_short: cutShort } });
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
  await record(reports);
  return { reports: done, expected, gapScan: gap };
}
