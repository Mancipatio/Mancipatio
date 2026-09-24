// SERVER-ONLY — the alarm worker (POST /api/internal/alarms, Talas 4.4b).
//
// Its own cron job, lease and budget (D7): a watcher that shared the retry
// worker's lease would go silent together with what it watches. The lease
// asserts the deployment network first (0072). Absolute deadlines from the
// run start:
//   events   until +20 s   onchain_event_jobs → alarms and ledger jobs
//   checks   until +30 s   incidents (queues, heartbeats, FX, holds, gap scan)
//   heartbeat at +30 s     events and checks status, before notify
//   notify   +30 → +40 s   one email digest, hard timeout
//   heartbeat by +44 s     final status
//   release  by +47 s
// It never calls assertWritable: alarms keep running in maintenance mode and
// while the program is paused. The response carries counts only.
//
// The checks stage is "failed" (a partial run: last_ok_at does not move)
// whenever fewer incidents were recorded than expected, including a check
// that could not run or a due gap scan that got no time; a gap scan that
// was started still stamps last_gap_scan_at, so a slow scan is not repeated
// every minute.

import "server-only";
import { randomUUID } from "node:crypto";
import { detectNetwork, type Network } from "@/lib/network";
import { runAlarmChecks } from "@/lib/server/alarm-checks";
import { reconcileEventJobs, type JobCounts } from "@/lib/server/onchain-alarms";
import { RetryWorkerError, leaseError } from "@/lib/server/retry-worker";
import { notifyPendingAlerts, type NotifyResult } from "@/lib/server/system-alerts";
import { getSupabaseAdmin } from "@/lib/supabase-server";

export const ALARM_DEADLINES_MS = { events: 20_000, checks: 30_000, notifyEnd: 40_000, heartbeat: 44_000, release: 47_000 } as const;
const LEASE_TTL_SECONDS = 120;
const LEASE_RPC_TIMEOUT_MS = 3_000;

type Stage<T> = { status: "processed"; counts: T } | { status: "failed"; counts: T | null } | { status: "deferred"; counts: null };
type CheckCounts = { reported: number; expected: number; failing: number; gapScan: boolean };
export type AlarmWorkerResult =
  | { status: "busy"; network: Network }
  | {
    status: "processed" | "partial"; network: Network;
    events: Stage<JobCounts>;
    checks: Stage<CheckCounts>;
    notify: { status: NotifyResult["status"] | "failed"; count: number };
  };

async function run<T>(work: (deadline: number, signal: AbortSignal) => Promise<T>, deadline: number): Promise<Stage<T>> {
  if (deadline <= Date.now()) return { status: "deferred", counts: null };
  const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  try {
    return { status: "processed", counts: await work(deadline, signal) };
  } catch {
    return { status: signal.aborted || Date.now() >= deadline ? "deferred" : "failed", counts: null };
  }
}

export async function runAlarmWorker(limit = 10): Promise<AlarmWorkerResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new RetryWorkerError(400, "Limit must be between 1 and 20");
  const network = detectNetwork();
  const owner = randomUUID();
  const start = Date.now();
  const at = (ms: number) => start + ms;
  const sb = getSupabaseAdmin();
  let acquired;
  try {
    acquired = await sb.rpc("acquire_worker_lease", {
      p_network: network, p_worker: "alarms", p_owner: owner, p_ttl_seconds: LEASE_TTL_SECONDS,
    }).abortSignal(AbortSignal.timeout(LEASE_RPC_TIMEOUT_MS));
  } catch { throw new RetryWorkerError(503, "Alarm worker lease unavailable"); }
  if (acquired.error) throw leaseError(acquired.error, "Alarm worker");
  if (typeof acquired.data !== "boolean") throw new RetryWorkerError(503, "Alarm worker lease unavailable");
  if (!acquired.data) return { status: "busy", network };

  const heartbeat = async (status: "processed" | "partial", gapScan: boolean, deadline: number) => {
    const budget = Math.max(1, Math.min(2_000, deadline - Date.now()));
    try {
      await sb.rpc("record_worker_heartbeat", {
        p_network: network, p_worker: "alarms", p_status: status, p_started_at: new Date(start).toISOString(), p_gap_scan: gapScan,
      }).abortSignal(AbortSignal.timeout(budget));
    } catch {
      console.error("[alarms] heartbeat not recorded");
    }
  };

  try {
    const events = await run((deadline, signal) => reconcileEventJobs(limit, deadline, signal), at(ALARM_DEADLINES_MS.events));
    const ran = await run(async (deadline, signal): Promise<CheckCounts> => {
      const result = await runAlarmChecks(sb, deadline, signal);
      return {
        reported: result.reports.length,
        expected: result.expected,
        failing: result.reports.filter((r) => r.state === "fail").length,
        gapScan: result.gapScan?.ran ?? false,
      };
    }, at(ALARM_DEADLINES_MS.checks));
    // Incidents not recorded (deadline, database, a check that could not run): never "processed".
    const checks: Stage<CheckCounts> = ran.status === "processed" && ran.counts.reported < ran.counts.expected
      ? { status: "failed", counts: ran.counts } : ran;
    // A checks stage that never ran (deferred) evaluated no incident either.
    const stagesOk = events.status !== "failed" && checks.status === "processed";
    // Before notify: a hanging mail server can never hide that events and checks ran.
    await heartbeat(stagesOk ? "processed" : "partial", checks.counts?.gapScan ?? false, at(ALARM_DEADLINES_MS.checks + 2_000));

    let notify: { status: NotifyResult["status"] | "failed"; count: number } = { status: "deferred", count: 0 };
    const notifyDeadline = at(ALARM_DEADLINES_MS.notifyEnd);
    if (notifyDeadline - Date.now() > 0) {
      try {
        const result = await notifyPendingAlerts(notifyDeadline, AbortSignal.timeout(Math.max(1, notifyDeadline - Date.now() + 500)), sb);
        notify = { status: result.status, count: "count" in result ? result.count : 0 };
      } catch {
        notify = { status: "failed", count: 0 };
      }
    }
    // Mainnet requires email (runbook §15); elsewhere an unconfigured outbox only waits.
    const notifyOk = notify.status !== "failed" && !(notify.status === "not_configured" && network === "mainnet");
    const status = stagesOk && notifyOk ? "processed" : "partial";
    await heartbeat(status, false, at(ALARM_DEADLINES_MS.heartbeat));
    return { status, network, events, checks, notify };
  } finally {
    const budget = Math.max(1_000, Math.min(LEASE_RPC_TIMEOUT_MS, at(ALARM_DEADLINES_MS.release) - Date.now()));
    let released;
    try {
      released = await sb.rpc("release_worker_lease", { p_network: network, p_worker: "alarms", p_owner: owner })
        .abortSignal(AbortSignal.timeout(budget));
    } catch { throw new RetryWorkerError(503, "Alarm worker lease release unavailable; lease will expire"); }
    if (released.error || released.data !== true) throw new RetryWorkerError(503, "Alarm worker lease release unavailable; lease will expire");
  }
}
