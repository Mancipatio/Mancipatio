// SERVER-ONLY — the alarm worker's checks (Talas 4.4b, design §3e/§4.2).
//
// Each check reports fail / hold / pass to report_incident (0072), which
// applies the hysteresis: an incident opens on the first failure, clears
// after 3 passes and 5 minutes without a failure, and a failure within 30
// minutes of a clear reopens the same alert silently. Clear thresholds sit
// below the fail thresholds; between them a check reports hold.
//
// The gap scan (at most every 5 minutes) lists the finalized signatures of
// the four watched addresses in [now − 20 min, now − 5 min]; any missing from
// indexer_events is fetched (finalized) and enqueued through the indexer's
// own path (enqueue_indexer_events), which repairs the mirror, and whose
// 0072 trigger creates the alarm job (source gap-scan). Only public account
// keys and {"source":"gap-scan"} are written.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ASSET_REGISTRY_PROGRAM_ADDRESS } from "@/lib/generated/asset_registry";
import { findBlocklistAuthorityPda } from "@/lib/generated/transfer_hook";
import { detectNetwork, type Network } from "@/lib/network";
import { QUEUE_FAIL_SECONDS, QUEUE_WARN_SECONDS, checkQueue, intervalSeconds, type QueueTable } from "@/lib/server/health";
import { programDataAddresses } from "@/lib/server/onchain-alarms";
import { finalizedTransaction, listFinalizedSignatures } from "@/lib/server/sale-capacity-chain";
import { reportIncident, type AlertCategory, type IncidentState, type Severity } from "@/lib/server/system-alerts";
import { resolveAccountKeys, type InvocationTx } from "@/lib/server/tx-invocations";

export const GAP_SCAN_EVERY_MS = 5 * 60_000;
export const GAP_WINDOW = { fromMs: 20 * 60_000, toMs: 5 * 60_000 } as const;
export const GAP_SCAN_PAGES = 5;
export const GAP_REPAIR_MAX = 20;
const LEDGER_QUEUE_FAIL_SECONDS = 30 * 60;
const LEDGER_QUEUE_CLEAR_SECONDS = 15 * 60;
const INDEXER_DEGRADED_SECONDS = 10 * 60;
const RETRY_FAIL_SECONDS = 10 * 60;
const RETRY_CLEAR_SECONDS = 3 * 60;
const HOLD_FAIL_SECONDS = 30 * 60;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type CheckReport = { check: string; state: IncidentState; severity: Severity };
export type ChecksResult = {
  reports: CheckReport[];
  gapScan: { ran: boolean; missing: number; repaired: number; complete: boolean } | null;
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

async function queueReports(sb: SupabaseClient, network: Network, now: number): Promise<Report[]> {
  const reports: Report[] = [];
  const lag = async (table: QueueTable) => {
    const q = await checkQueue(sb, table, network, now, "fail");
    if (q.reason === "timeout" || q.reason === "unavailable" || q.reason === "not_configured") return undefined;
    return q.oldestPendingAgeSeconds;
  };
  for (const [check, table, category, source, label] of [
    ["indexer-queue", "indexer_jobs", "indexer", "indexer:queue-lag", "Indexer"],
    ["event-queue", "onchain_event_jobs", "worker", "worker:event-queue", "Alarm"],
  ] as const) {
    const age = await lag(table);
    if (age === undefined) continue;
    const state = thresholdState(age, QUEUE_WARN_SECONDS, QUEUE_WARN_SECONDS / 2);
    const severity: Severity = age !== null && age >= QUEUE_FAIL_SECONDS ? "high" : "medium";
    reports.push({ check, state, severity, category, source,
      summary: `${label} queue: the oldest pending job is ${Math.round((age ?? 0) / 60)} minutes old`,
      evidence: { oldest_pending_seconds: age } });
  }
  const ledgerAge = await lag("spv_issuance_jobs");
  if (ledgerAge !== undefined) {
    reports.push({ check: "ledger-queue", state: thresholdState(ledgerAge, LEDGER_QUEUE_FAIL_SECONDS, LEDGER_QUEUE_CLEAR_SECONDS),
      severity: "high", category: "ledger", source: "ledger:queue-lag",
      summary: `Raise-cap ledger queue: the oldest pending job is ${Math.round((ledgerAge ?? 0) / 60)} minutes old`,
      evidence: { oldest_pending_seconds: ledgerAge } });
  }
  return reports;
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

/** fx-stale:<mint>, fx-missing:<mint> and capacity-holds. */
async function fxAndHolds(sb: SupabaseClient, network: Network, now: number, signal: AbortSignal): Promise<Report[]> {
  const [holdsRes, fxRes, liveRes, openSalesRes, openIncidents] = await Promise.all([
    sb.from("sale_capacity_holds").select("subject,ref,code,payment_mint,created_at").eq("network", network).limit(500).abortSignal(dbSignal(signal)),
    sb.from("fx_rates").select("payment_mint,kind,as_of,max_age").eq("network", network).abortSignal(dbSignal(signal)),
    sb.from("sale_capacity_reservations").select("payment_mint").eq("network", network).eq("kind", "sale")
      .in("status", ["reserved", "consumed"]).limit(1000).abortSignal(dbSignal(signal)),
    sb.from("sales").select("payment_mint").eq("network", network).eq("status", 0).limit(1000).abortSignal(dbSignal(signal)),
    sb.from("alarm_incidents").select("check_key").eq("network", network).is("cleared_at", null).not("last_fail_at", "is", null)
      .like("check_key", "fx-%").abortSignal(dbSignal(signal)),
  ]);
  if (holdsRes.error || fxRes.error || liveRes.error || openSalesRes.error) return [];
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

/** Gap scan of the four watched addresses; repairs up to GAP_REPAIR_MAX missing transactions. */
export async function gapScan(sb: SupabaseClient, network: Network, now: number, signal: AbortSignal) {
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
  const signatures = [...seen.keys()];
  const known = new Set<string>();
  for (let i = 0; i < signatures.length; i += 100) {
    const { data, error } = await sb.from("indexer_events").select("signature").eq("network", network)
      .in("signature", signatures.slice(i, i + 100)).abortSignal(dbSignal(signal));
    if (error) throw new Error("Indexer events unavailable");
    for (const row of (data ?? []) as { signature: string }[]) known.add(row.signature);
  }
  const missing = signatures.filter((s) => !known.has(s));
  let repaired = 0;
  for (const sig of missing.slice(0, GAP_REPAIR_MAX)) {
    if (signal.aborted) break;
    const tx = (await finalizedTransaction(sig, signal)) as (InvocationTx & { slot?: number | bigint }) | null;
    if (!tx) continue;
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
  return { missing: missing.length, repaired, complete };
}

/** Whether a gap scan is due (last one ≥ 5 min ago, from the alarms heartbeat). */
async function gapScanDue(sb: SupabaseClient, network: Network, now: number, signal: AbortSignal): Promise<boolean> {
  const { data, error } = await sb.from("worker_heartbeats").select("last_gap_scan_at").eq("network", network).eq("worker", "alarms")
    .abortSignal(dbSignal(signal)).maybeSingle();
  if (error) return false;
  const at = (data as { last_gap_scan_at?: string | null } | null)?.last_gap_scan_at;
  return !at || now - Date.parse(at) >= GAP_SCAN_EVERY_MS;
}

/** Every check, then report_incident for each. Throws only when nothing could be read. */
export async function runAlarmChecks(sb: SupabaseClient, deadlineMs: number, signal: AbortSignal): Promise<ChecksResult> {
  const network = detectNetwork();
  const now = Date.now();
  const reports: Report[] = [];
  const collect = async (work: () => Promise<Report | Report[] | null>) => {
    if (signal.aborted || Date.now() >= deadlineMs) return;
    try {
      const r = await work();
      if (Array.isArray(r)) reports.push(...r);
      else if (r) reports.push(r);
    } catch {
      console.error("[alarms] a check could not run");
    }
  };
  await collect(() => queueReports(sb, network, now));
  await collect(() => indexerDegraded(sb, network, now, signal));
  await collect(() => eventInvalid(sb, network, now, signal));
  await collect(() => retryHeartbeat(sb, network, now, signal));
  await collect(() => fxAndHolds(sb, network, now, signal));
  let gap: ChecksResult["gapScan"] = null;
  if (!signal.aborted && Date.now() < deadlineMs && (await gapScanDue(sb, network, now, signal))) {
    try {
      const result = await gapScan(sb, network, now, signal);
      gap = { ran: true, ...result };
      reports.push({ check: "indexer-gap", state: result.missing ? "fail" : "pass", severity: "high", category: "indexer",
        source: "indexer:gap", summary: `${result.missing} finalized program transaction(s) were missing from the index (${result.repaired} re-queued)`,
        evidence: { missing: result.missing, repaired: result.repaired } });
      reports.push({ check: "gap-scan-incomplete", state: result.complete ? "pass" : "fail", severity: "medium", category: "indexer",
        source: "indexer:gap-scan-incomplete", summary: "The gap scan ran out of pages before the start of its window",
        evidence: { window_minutes: [GAP_WINDOW.fromMs / 60_000, GAP_WINDOW.toMs / 60_000] } });
    } catch {
      console.error("[alarms] gap scan failed");
    }
  }
  const done: CheckReport[] = [];
  for (const r of reports) {
    if (signal.aborted) break;
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
  if (reports.length && !done.length) throw new Error("Incidents unavailable");
  return { reports: done, gapScan: gap };
}
