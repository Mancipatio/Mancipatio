import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
import { applyMigrations, TEST_PROJECT_REFS } from "./helpers/migrations";

// scripts/ops/sanctions-scheduler.sql (8.5) the way db.sh runs it
// (assert-target.sql first), after the retry scheduler whose single-row
// worker target it uses. pg_cron, Vault and the http extension are modelled,
// as in alarm-scheduler.postgres.test.ts; migration 0078 is stubbed by the two
// objects the installer checks for.
const ORIGIN = "https://www.manci.io";
const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8").replace(/^create extension .*;$/gm, "");
const ASSERT = readFileSync(join(process.cwd(), "scripts/ops/assert-target.sql"), "utf8");
const RETRY = read("scripts/ops/retry-scheduler.sql");
const SANCTIONS = read("scripts/ops/sanctions-scheduler.sql");
const STATUS = read("scripts/ops/sanctions-scheduler-status.sql");
const vars = (network: string, origin: string) => ({ target_network: network, target_ref: TEST_PROJECT_REFS[network as "devnet"], target_origin: origin, bootstrap: "0" });
const reply = (network: string, status: "processed" | "failed" = "processed") => JSON.stringify({
  ok: status === "processed",
  data: status === "processed"
    ? { status, network, source: "ofac-sdn", publishedOn: "2026-09-23", addresses: 4, removed: 0, skipped: 1055 }
    : { status, network, source: "ofac-sdn", error: "HTTP_ERROR" },
  privateExtra: "DO_NOT_PERSIST",
});

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("sanctions scheduler SQL on a devnet project", () => {
  const db = new LocalPostgres();
  const run = () => {
    db.query("select mancipatio_ops.invoke_sanctions_refresh()");
    return JSON.parse(db.query("select row_to_json(r) from mancipatio_ops.sanctions_http_runs r order by id desc limit 1"));
  };
  beforeAll(() => {
    try {
      db.initialize();
      db.query(`create role anon;create role authenticated;create role service_role;
        create schema vault;create schema extensions;create schema cron;
        create table public.purchase_evidence_jobs(id int);create table public.indexer_jobs(id int);create table public.distribution_plans(id int);
        create table public.onchain_event_jobs(id int);
        create table public.sanctions_list_state(source text,published_on date,record_count int,address_count int,refreshed_at timestamptz,last_attempt_at timestamptz,last_status text,last_error text);
        create table public.sanctions_addresses(source text,last_seen_at timestamptz);
        create table public.compliance_alerts(network text,status text,created_at timestamptz,evidence jsonb);
        create function public.replace_sanctions_list(text,date,integer,text,jsonb) returns jsonb language sql as 'select null::jsonb';
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
        create table extensions.mock_response(status integer,body text,last_uri text,last_headers text);
        create function extensions.http_reset_curlopt() returns boolean language sql as 'select true';
        create function extensions.http_set_curlopt(n text,v text) returns boolean language sql as 'select true';
        create function extensions.http(r extensions.http_request) returns extensions.http_response language plpgsql as $$ declare m record;begin
          if (r.headers[1]).value<>'Bearer '||repeat('x',64) then raise exception 'Unexpected request';end if;
          update extensions.mock_response set last_uri=r.uri,last_headers=(select string_agg(h.field||'='||h.value,'|' order by h.n) from unnest(r.headers) with ordinality as h(field,value,n));
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
    expect(() => db.query(ASSERT + "\n" + SANCTIONS, vars("devnet", ORIGIN))).toThrow(/Install scripts\/ops\/retry-scheduler.sql first/);
  });

  it("installs one disabled daily job on the single-row worker target, and refuses another origin or network", () => {
    db.query(ASSERT + "\n" + RETRY, vars("devnet", ORIGIN));
    db.query(ASSERT + "\n" + SANCTIONS, vars("devnet", ORIGIN));
    expect(db.query("select jobname||'|'||schedule||'|'||active from cron.job where jobname like 'mancipatio-sanctions-%'"))
      .toBe("mancipatio-sanctions-devnet|17 5 * * *|false");
    expect(() => db.query(ASSERT + "\n" + SANCTIONS, vars("devnet", "https://other.manci.io"))).toThrow(/is not the target's siteOrigin/);
    expect(() => db.query(ASSERT + "\n" + SANCTIONS, vars("mainnet", ORIGIN))).toThrow(/Target mismatch/);
  });

  it("records counts, states and codes only; a response bound to another network is invalid_response", () => {
    const ok = run();
    expect(ok).toMatchObject({ ok: true, outcome: "complete", refresh_state: "processed", addresses: 4, error_code: null });
    expect(JSON.stringify(ok)).not.toMatch(/DO_NOT_PERSIST|Bearer/);
    expect(db.query("select last_uri from extensions.mock_response")).toBe(`${ORIGIN}/api/internal/sanctions`);
    db.query(`update extensions.mock_response set body='${reply("mainnet")}'`);
    expect(run()).toMatchObject({ ok: false, outcome: "invalid_response", refresh_state: null });
    db.query(`update extensions.mock_response set status=503, body='${reply("devnet", "failed")}'`);
    expect(run()).toMatchObject({ ok: false, outcome: "http_error", refresh_state: "failed", error_code: "HTTP_ERROR" });
  });

  it("is private to its operator; the status SQL reads it", () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(() => db.query(`set role ${role};select * from mancipatio_ops.sanctions_http_runs`)).toThrow(/permission denied/);
      expect(() => db.query(`set role ${role};select mancipatio_ops.invoke_sanctions_refresh()`)).toThrow(/permission denied/);
    }
    expect(() => db.query(STATUS)).not.toThrow();
  });
});
