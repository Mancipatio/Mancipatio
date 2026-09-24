import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
import { applyMigrations, TEST_PROJECT_REFS } from "./helpers/migrations";

// scripts/ops/alarm-scheduler.sql the way db.sh runs it (assert-target.sql
// first), after the retry scheduler whose single-row worker target it uses.
// pg_cron, Vault and the http extension are modelled, as in
// retry-scheduler.postgres.test.ts.
const ORIGIN = "https://www.manci.io";
const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8").replace(/^create extension .*;$/gm, "");
const ASSERT = readFileSync(join(process.cwd(), "scripts/ops/assert-target.sql"), "utf8");
const RETRY = read("scripts/ops/retry-scheduler.sql");
const ALARMS = read("scripts/ops/alarm-scheduler.sql");
const vars = (network: string, origin: string) => ({ target_network: network, target_ref: TEST_PROJECT_REFS[network as "devnet"], target_origin: origin, bootstrap: "0" });
const reply = (network: string, status = "processed") => JSON.stringify({ ok: status !== "partial", data: {
  network, status, events: { counts: { complete: 4, pending: 1, invalid: 0 } }, checks: { counts: { reported: 9, failing: 2 } },
  notify: { status: "sent", count: 2 } }, privateExtra: "DO_NOT_PERSIST" });

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("alarm scheduler SQL on a devnet project", () => {
  const db = new LocalPostgres();
  const run = () => { db.query("select mancipatio_ops.invoke_alarm_worker()"); return JSON.parse(db.query("select row_to_json(r) from mancipatio_ops.alarm_http_runs r order by id desc limit 1")); };
  beforeAll(() => {
    try {
      db.initialize();
      db.query(`create role anon;create role authenticated;create role service_role;
        create schema vault;create schema extensions;create schema cron;
        create table public.purchase_evidence_jobs(id int);create table public.indexer_jobs(id int);create table public.distribution_plans(id int);
        create table public.onchain_event_jobs(id int);
        create function public.acquire_worker_lease(text,text,uuid,integer) returns boolean language sql as 'select true';
        create table vault.secrets(name text primary key,decrypted_secret text);
        insert into vault.secrets values('mancipatio_retry_worker_devnet',repeat('x',64));
        create view vault.decrypted_secrets as select * from vault.secrets;
        create table cron.job(jobid bigint primary key,jobname text,schedule text,command text,active boolean,
          username text not null default current_user,unique(jobname,username));
        create table cron.job_run_details(jobid bigint,status text,start_time timestamptz);
        create function cron.schedule(n text,s text,c text) returns bigint language plpgsql as $$ declare id bigint;begin
          insert into cron.job(jobid,jobname,schedule,command,active) values((select coalesce(max(jobid),0)+1 from cron.job),n,s,c,true)
            on conflict(jobname,username) do update set schedule=excluded.schedule,command=excluded.command returning jobid into id;
          return id;end;$$;
        create function cron.alter_job(bigint,active boolean) returns void language sql as $$ update cron.job set active=$2 where jobid=$1 $$;
        create type extensions.http_header as(field varchar,value varchar);
        create type extensions.http_request as(method text,uri varchar,headers extensions.http_header[],content_type varchar,content varchar);
        create type extensions.http_response as(status integer,content_type varchar,headers extensions.http_header[],content varchar);
        create table extensions.mock_response(status integer,body text,last_uri text);
        create function extensions.http_reset_curlopt() returns boolean language sql as 'select true';
        create function extensions.http_set_curlopt(n text,v text) returns boolean language sql as 'select true';
        create function extensions.http(r extensions.http_request) returns extensions.http_response language plpgsql as $$ declare m record;begin
          if (r.headers[1]).value<>'Bearer '||repeat('x',64) then raise exception 'Unexpected request';end if;
          update extensions.mock_response set last_uri=r.uri;
          select * into m from extensions.mock_response;
          return (m.status,'application/json',array[]::extensions.http_header[],m.body)::extensions.http_response;
        end;$$;`);
      applyMigrations(db, { network: "devnet", files: ["0070_deployment_identity.sql"] });
    } catch (error) {
      db.close();
      throw error;
    }
  }, 30_000);
  afterAll(() => db.close());
  beforeEach(() => db.query(`truncate extensions.mock_response; insert into extensions.mock_response(status,body) values(200,'${reply("devnet")}')`));

  it("refuses to install before the retry scheduler's worker target exists", () => {
    expect(() => db.query(ASSERT + "\n" + ALARMS, vars("devnet", ORIGIN))).toThrow(/Install scripts\/ops\/retry-scheduler.sql first/);
  });

  it("installs one disabled job on the single-row worker target, and refuses another origin or network", () => {
    db.query(ASSERT + "\n" + RETRY, vars("devnet", ORIGIN));
    db.query(ASSERT + "\n" + ALARMS, vars("devnet", ORIGIN));
    expect(db.query("select jobname||'|'||active from cron.job where jobname like 'mancipatio-alarms-%'")).toBe("mancipatio-alarms-devnet|false");
    expect(db.query("select count(*) from mancipatio_ops.retry_worker_config")).toBe("1");
    expect(() => db.query(ASSERT + "\n" + ALARMS, vars("devnet", "https://other.manci.io"))).toThrow(/is not the target's siteOrigin/);
    expect(() => db.query(ASSERT + "\n" + ALARMS, vars("mainnet", ORIGIN))).toThrow(/Target mismatch/);
  });

  it("records counts and states only; a response bound to another network is invalid_response", () => {
    const ok = run();
    expect(ok).toMatchObject({ ok: true, outcome: "complete", worker_state: "processed", events_complete: 4, checks_failing: 2, notify_state: "sent" });
    expect(JSON.stringify(ok)).not.toMatch(/DO_NOT_PERSIST|Bearer/);
    expect(db.query("select last_uri from extensions.mock_response")).toBe(`${ORIGIN}/api/internal/alarms?limit=20`);
    db.query(`update extensions.mock_response set body='${reply("mainnet")}'`);
    expect(run()).toMatchObject({ ok: false, outcome: "invalid_response", worker_state: null, events_complete: null });
    db.query(`update extensions.mock_response set status=503, body='${reply("devnet", "partial")}'`);
    expect(run()).toMatchObject({ ok: false, outcome: "http_error", worker_state: "partial" });
  });

  it("is private to its operator; the status SQL reads it", () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(() => db.query(`set role ${role};select * from mancipatio_ops.alarm_http_runs`)).toThrow(/permission denied/);
      expect(() => db.query(`set role ${role};select mancipatio_ops.invoke_alarm_worker()`)).toThrow(/permission denied/);
    }
  });
});
