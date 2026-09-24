// Migration 0072 (Talas 4.4b) on the whole migration chain: system alerts,
// the outbox backoff, incidents with hysteresis, the indexer_events trigger,
// worker leases and heartbeats, and the deployment-network assertion.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
import { applyMigrations, SUPABASE_PLATFORM_SQL } from "./helpers/migrations";

const db = new LocalPostgres();
const sql = (q: string) => db.query(q);
const json = (q: string) => JSON.parse(sql(q)) as Record<string, unknown>;
const SIG = "5".repeat(88);
const alert = (key: string, severity = "high", notify = true) =>
  json(`select public.raise_system_alert('devnet','${key}','onchain','onchain:pause','${severity}','Pause set','{"a":1}'::jsonb,'${SIG}',${notify})`);
const incident = (state: "fail" | "hold" | "pass", severity = "high", check = "worker-retry") =>
  json(`select public.report_incident('devnet','${check}','${state}','worker','worker:retry-heartbeat','${severity}','Retry worker stalled','{}'::jsonb,true)`);
const row = (id: unknown) => json(`select to_jsonb(a) from public.compliance_alerts a where id='${id}'`);
const age = (minutes: number, check = "worker-retry") =>
  sql(`update public.alarm_incidents set last_fail_at = last_fail_at - interval '${minutes} minutes',
    cleared_at = cleared_at - interval '${minutes} minutes' where check_key='${check}'`);

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("0072 on-chain alarms", () => {
  beforeAll(() => {
    try {
      db.initialize();
      sql(SUPABASE_PLATFORM_SQL);
      applyMigrations(db, { network: "devnet" });
    } catch (error) {
      db.close();
      throw error;
    }
  }, 90_000);
  afterAll(() => db.close());

  it("raise_system_alert is idempotent on (network, dedup_key), never names a wallet, and validates its input", () => {
    const first = alert(`onchain:${SIG}:0`);
    expect(first.inserted).toBe(true);
    expect(alert(`onchain:${SIG}:0`)).toEqual({ id: first.id, inserted: false });
    expect(row(first.id)).toMatchObject({ wallet: null, client_id: null, status: "open", confidence: 100, category: "onchain",
      notify_state: "pending", notify_attempts: 0 });
    expect(row(alert(`onchain:${SIG}:1`, "low").id)).toMatchObject({ notify_state: "skipped" });
    for (const bad of [
      `select public.raise_system_alert('devnet','bad key','onchain','onchain:pause','high','x','{}'::jsonb,null,true)`,
      `select public.raise_system_alert('devnet','test:x','nope','onchain:pause','high','x','{}'::jsonb,null,true)`,
      `select public.raise_system_alert('devnet','test:x','onchain','Bad Source','high','x','{}'::jsonb,null,true)`,
      `select public.raise_system_alert('devnet','test:x','onchain','onchain:pause','high','','{}'::jsonb,null,true)`,
      `select public.raise_system_alert('devnet','test:x','onchain','onchain:pause','high','x','[]'::jsonb,null,true)`,
      `select public.raise_system_alert('devnet','test:x','onchain','onchain:pause','high','x',jsonb_build_object('a',repeat('x',11000)),null,true)`,
      `select public.raise_system_alert('devnet','test:x','onchain','onchain:pause','high','x','{}'::jsonb,'not-a-signature',true)`,
      `select public.raise_system_alert('mainnet','test:x','onchain','onchain:pause','high','x','{}'::jsonb,null,true)`,
    ]) expect(() => sql(bad), bad).toThrow();
  });

  it("the outbox: backoff on failure; medium gives up after 20 attempts, critical never; sent records the severity", () => {
    const medium = alert("test:medium", "medium").id;
    const critical = alert("test:critical", "critical").id;
    const fail = (id: unknown, severity: string) => sql(`select public.finish_alert_notifications('devnet',
      '[{"id":"${id}","severity":"${severity}"}]'::jsonb,false,'SEND_FAILED')`);
    fail(medium, "medium");
    const after = row(medium);
    expect(after).toMatchObject({ notify_state: "pending", notify_attempts: 1, notify_error: "SEND_FAILED" });
    expect(Date.parse(String(after.next_notify_at)) - Date.now()).toBeGreaterThan(50_000);
    for (let i = 0; i < 19; i++) fail(medium, "medium");
    expect(row(medium)).toMatchObject({ notify_state: "failed", notify_attempts: 20 });
    for (let i = 0; i < 25; i++) fail(critical, "critical");
    const c = row(critical);
    expect(c).toMatchObject({ notify_state: "pending", notify_attempts: 25 });
    expect(Date.parse(String(c.next_notify_at)) - Date.now()).toBeLessThanOrEqual(1_800_000);
    sql(`select public.finish_alert_notifications('devnet','[{"id":"${critical}","severity":"critical"}]'::jsonb,true,null)`);
    expect(row(critical)).toMatchObject({ notify_state: "sent", notified_severity: "critical", notify_error: null });
    // A row whose severity rose after the digest read it stays pending.
    const rising = alert("test:rising", "medium").id;
    sql(`update public.compliance_alerts set severity='critical' where id='${rising}'`);
    sql(`select public.finish_alert_notifications('devnet','[{"id":"${rising}","severity":"medium"}]'::jsonb,true,null)`);
    expect(row(rising)).toMatchObject({ notify_state: "pending" });
  });

  it("incidents: open, escalate re-queues, pass streak and 5 minutes clear, escalated alerts are left to humans", () => {
    const opened = incident("fail", "medium");
    expect(opened.action).toBe("opened");
    sql(`update public.compliance_alerts set notify_state='sent', notified_severity='medium' where id='${opened.alert_id}'`);
    expect(incident("fail", "medium").action).toBe("updated");
    expect(row(opened.alert_id)).toMatchObject({ notify_state: "sent" });
    expect(incident("fail", "high")).toEqual({ action: "raised", alert_id: opened.alert_id });
    expect(row(opened.alert_id)).toMatchObject({ severity: "high", notify_state: "pending" });
    // Three passes clear only once 5 minutes passed since the last failure.
    incident("pass"); incident("pass");
    expect(incident("pass").action).toBe("pass");
    age(6);
    expect(incident("pass").action).toBe("cleared");
    expect(row(opened.alert_id)).toMatchObject({ status: "resolved", resolved_by: "system", resolution_note: "Recovered automatically" });
    // An escalated alert is never resolved automatically.
    const esc = incident("fail", "high", "event-queue");
    sql(`update public.compliance_alerts set status='escalated' where id='${esc.alert_id}'`);
    incident("pass", "high", "event-queue"); incident("pass", "high", "event-queue"); age(6, "event-queue");
    expect(incident("pass", "high", "event-queue").action).toBe("cleared");
    expect(row(esc.alert_id)).toMatchObject({ status: "escalated" });
    // hold resets the streak and changes nothing else.
    expect(incident("hold", "high", "event-queue").action).toBe("hold");
  });

  it("a flapping check over 20 runs sends exactly one email: the reopen within 30 minutes is silent", () => {
    const check = "indexer-gap";
    const first = incident("fail", "high", check);
    sql(`update public.compliance_alerts set notify_state='sent', notified_severity='high' where id='${first.alert_id}'`);
    for (let run = 0; run < 20; run++) {
      if (run % 5 === 4) { age(6, check); incident("pass", "high", check); incident("pass", "high", check); }
      incident(run % 2 ? "pass" : "fail", "high", check);
    }
    expect(sql(`select count(*) from public.compliance_alerts where dedup_key like 'incident:${check}:%'`)).toBe("1");
    expect(row(first.alert_id)).toMatchObject({ notify_state: "sent" });
    expect(Number((row(first.alert_id).evidence as { reopened?: number }).reopened ?? 0)).toBeGreaterThan(0);
  });

  it("a human-acknowledged ongoing incident stays silent unless it gets worse; after the cooldown a new alert opens", () => {
    const check = "ledger-queue";
    const first = incident("fail", "high", check);
    sql(`update public.compliance_alerts set status='resolved', resolved_by='admin' where id='${first.alert_id}'`);
    expect(incident("fail", "high", check).action).toBe("acknowledged");
    const worse = incident("fail", "critical", check);
    expect(worse.action).toBe("opened");
    expect(worse.alert_id).not.toBe(first.alert_id);
    // Cleared long ago: a new failure opens a new alert.
    incident("pass", "high", check); incident("pass", "high", check); age(6, check); incident("pass", "high", check);
    age(40, check);
    const again = incident("fail", "high", check);
    expect(again.action).toBe("opened");
    expect(again.alert_id).not.toBe(worse.alert_id);
  });

  it("an indexer_events insert creates exactly one alarm job; a duplicate delivery none; the gap scan's payload marks its source", () => {
    const event = (sig: string, ix: string, payload: string) =>
      `select public.enqueue_indexer_events('devnet','[{"signature":"${sig}","slot":1,"ix_name":"${ix}","wallets":["${SIG.slice(0, 44)}"],"payload":${payload}}]'::jsonb)`;
    sql(event("2".repeat(88), "TRANSFER", `{"type":"TRANSFER"}`));
    sql(event("2".repeat(88), "TRANSFER", `{"type":"TRANSFER"}`));
    sql(event("3".repeat(88), "GAP_SCAN", `{"source":"gap-scan"}`));
    // A webhook payload that merely says "gap-scan" is still a webhook job.
    sql(event("4".repeat(88), "TRANSFER", `{"source":"gap-scan"}`));
    expect(sql(`select string_agg(left(signature,1)||':'||source||':'||status, ',' order by signature) from public.onchain_event_jobs`))
      .toBe("2:webhook:pending,3:gap-scan:pending,4:webhook:pending");
  });

  it("worker leases and heartbeats: one owner at a time; last_ok_at moves only on a processed run", () => {
    const owner = "0b6f7a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b";
    expect(sql(`select public.acquire_worker_lease('devnet','alarms','${owner}',120)`)).toBe("t");
    expect(sql(`select public.acquire_worker_lease('devnet','alarms',gen_random_uuid(),120)`)).toBe("f");
    expect(sql(`select public.release_worker_lease('devnet','alarms','${owner}')`)).toBe("t");
    sql(`select public.record_worker_heartbeat('devnet','alarms','processed',now(),true)`);
    const ok = sql(`select last_ok_at from public.worker_heartbeats where worker='alarms'`);
    sql(`select pg_sleep(0.01); select public.record_worker_heartbeat('devnet','alarms','partial',now(),false)`);
    expect(sql(`select last_ok_at from public.worker_heartbeats where worker='alarms'`)).toBe(ok);
    expect(sql(`select last_status||':'||(last_gap_scan_at is not null) from public.worker_heartbeats where worker='alarms'`)).toBe("partial:true");
  });

  it("the deployment network: another network refuses both leases (0070's identity, the guard's rule)", () => {
    expect(sql("select public.assert_deployment_network('devnet')")).toBe("devnet");
    expect(sql("select public.assert_deployment_network('testnet')")).toBe("devnet");
    for (const q of [
      "select public.assert_deployment_network('mainnet')",
      "select public.acquire_worker_lease('mainnet','alarms',gen_random_uuid(),120)",
      "select public.acquire_retry_worker_lease('mainnet',gen_random_uuid(),120)",
    ]) expect(() => sql(q)).toThrow(/DEPLOYMENT_NETWORK_MISMATCH database=devnet deployment=mainnet/);
  });

  it("every new table and function is the service role's only", () => {
    for (const role of ["anon", "authenticated"]) {
      for (const table of ["onchain_event_jobs", "worker_leases", "worker_heartbeats", "alarm_incidents"]) {
        expect(() => sql(`set role ${role}; select * from public.${table}`)).toThrow(/permission denied/);
      }
      expect(() => sql(`set role ${role}; select public.raise_system_alert('devnet','test:y','worker','worker:test','high','x','{}'::jsonb,null,true)`))
        .toThrow(/permission denied/);
      expect(() => sql(`set role ${role}; select public.report_incident('devnet','x','fail','worker','worker:test','high','x','{}'::jsonb,true)`))
        .toThrow(/permission denied/);
    }
    expect(sql(`set role service_role; select (public.raise_system_alert('devnet','test:svc','worker','worker:test','medium','x','{}'::jsonb,null,true))->>'inserted'`))
      .toBe("true");
  });
});
