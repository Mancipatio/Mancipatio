// SERVER-ONLY — the alarm dead-man switch (GET /api/health/alarms, Talas 4.4b).
//
// An external uptime monitor polls it every 5 minutes (D10). ok requires
// all of:
//   - the database serves this deployment's network (lib/server/health.ts
//     databaseNetwork, on 0070's identity);
//   - the alarm worker finished a full run within 5 minutes;
//   - no notification is stuck: none due for 15 minutes, none that failed 3
//     times in a row (the email path is broken) — skipped only when email is
//     not configured on a non-mainnet network (mainnet requires it);
//   - no notification gave up ('failed') on an alert that is still open or
//     escalated: it stays 503 until someone resolves the alert or re-queues
//     the notification (runbook §15).
// Anonymous callers get only {ok, network, checkedAt}; reasons stay here.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { detectNetwork, type Network } from "@/lib/network";
import { emailConfigured } from "@/lib/server/email";
import { HEALTH_DB_TIMEOUT_MS, TIMEOUT, ageSeconds, bounded, checkDatabaseNetwork } from "@/lib/server/health";
import { alertRecipients } from "@/lib/server/system-alerts";
import { getSupabaseAdmin } from "@/lib/supabase-server";

export type AlarmHealth = { ok: boolean; network: Network; checkedAt: string; reasons: string[] };
export const ALARM_HEARTBEAT_MAX_AGE_SECONDS = 5 * 60;
const NOTIFY_OVERDUE_SECONDS = 15 * 60;
const NOTIFY_FAILING_ATTEMPTS = 3;
const CACHE_MS = 10_000;

export async function runAlarmHealth(): Promise<AlarmHealth> {
  const network = detectNetwork();
  const now = Date.now();
  const reasons: string[] = [];
  let sb: SupabaseClient | null = null;
  try {
    sb = getSupabaseAdmin();
  } catch {
    sb = null;
  }
  const database = await checkDatabaseNetwork(sb, network);
  if (database.status !== "ok") reasons.push(`database_network:${database.reason ?? "fail"}`);
  const checkedAt = new Date(now).toISOString();
  if (!sb) return { ok: false, network, checkedAt, reasons: [...reasons, "not_configured"] };
  const client = sb;
  try {
    const beat = await bounded((signal) => client.from("worker_heartbeats").select("last_ok_at")
      .eq("network", network).eq("worker", "alarms").abortSignal(signal).maybeSingle(), HEALTH_DB_TIMEOUT_MS);
    if (beat === TIMEOUT || beat.error) reasons.push("alarm_heartbeat:unavailable");
    else {
      const age = ageSeconds((beat.data as { last_ok_at?: unknown } | null)?.last_ok_at, now);
      if (age === null || age > ALARM_HEARTBEAT_MAX_AGE_SECONDS) reasons.push("alarm_heartbeat:stale");
    }
    const configured = alertRecipients() !== null && emailConfigured();
    if (!configured && network === "mainnet") reasons.push("email:not_configured");
    if (configured || network === "mainnet") {
      const overdue = new Date(now - NOTIFY_OVERDUE_SECONDS * 1000).toISOString();
      const pending = await bounded((signal) => client.from("compliance_alerts").select("id", { count: "exact", head: true })
        .eq("network", network).eq("notify_state", "pending")
        .or(`next_notify_at.lt.${overdue},notify_attempts.gte.${NOTIFY_FAILING_ATTEMPTS}`).abortSignal(signal), HEALTH_DB_TIMEOUT_MS);
      if (pending === TIMEOUT || pending.error) reasons.push("notify_pending:unavailable");
      else if ((pending.count ?? 0) > 0) reasons.push("notify_pending:stuck");
    }
    const failed = await bounded((signal) => client.from("compliance_alerts").select("id", { count: "exact", head: true })
      .eq("network", network).eq("notify_state", "failed").in("status", ["open", "escalated"]).abortSignal(signal), HEALTH_DB_TIMEOUT_MS);
    if (failed === TIMEOUT || failed.error) reasons.push("notify_failed:unavailable");
    else if ((failed.count ?? 0) > 0) reasons.push("notify_failed:unacknowledged");
  } catch {
    reasons.push("unavailable");
  }
  return { ok: reasons.length === 0, network, checkedAt, reasons };
}

let cached: { at: number; report: AlarmHealth } | null = null;
let inflight: Promise<AlarmHealth> | null = null;

/** At most 10 s old per instance; concurrent callers share one run. */
export async function readAlarmHealth(): Promise<AlarmHealth> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.report;
  if (!inflight) {
    inflight = runAlarmHealth()
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

/** Test hook: forget the cached report. */
export function resetAlarmHealthCache() {
  cached = null;
  inflight = null;
}
