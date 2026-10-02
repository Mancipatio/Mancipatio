import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
import { applyMigrations, TEST_PROJECT_REFS } from "./helpers/migrations";

// scripts/ops/fx-scheduler.sql (0080) the way db.sh runs it
// (assert-target.sql first), after the retry scheduler whose single-row
// worker target it uses. pg_cron, Vault and the http extension are modelled,
// as in sanctions-scheduler.postgres.test.ts; migration 0080 is stubbed by
// the two objects the installer checks for, plus what the status SQL reads.
const TARGETS = JSON.parse(readFileSync(join(process.cwd(), "scripts/ops/targets.json"), "utf8")) as Record<"devnet" | "mainnet", { siteOrigin: string }>;
const ORIGIN = TARGETS.devnet.siteOrigin;
const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8").replace(/^create extension .*;$/gm, "");
const ASSERT = readFileSync(join(process.cwd(), "scripts/ops/assert-target.sql"), "utf8");
const RETRY = read("scripts/ops/retry-scheduler.sql");
const FX = read("scripts/ops/fx-scheduler.sql");
const STATUS = read("scripts/ops/fx-scheduler-status.sql");
const vars = (network: string, origin: string) => ({ target_network: network, target_ref: TEST_PROJECT_REFS[network as "devnet"], target_origin: origin, bootstrap: "0" });
const reply = (network: string, data: Record<string, unknown> = { status: "accepted", rate: "0.88895" }) => JSON.stringify({
  ok: data.status !== "failed",
  data: { network, paymentMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", ...data },
  privateExtra: "DO_NOT_PERSIST",
});

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("fx scheduler SQL on a devnet project", () => {
  const db = new LocalPostgres();
  const run = () => {
    db.query("select mancipatio_ops.invoke_fx_refresh()");
    return JSON.parse(db.query("select row_to_json(r) from mancipatio_ops.fx_http_runs r order by id desc limit 1"));
  };
  beforeAll(() => {
    try {
      db.initialize();
      db.query(`create role anon;create role authenticated;create role service_role;
        create schema vault;create schema extensions;create schema cron;
        create table public.purchase_evidence_jobs(id int);create table public.indexer_jobs(id int);create table public.distribution_plans(id int);
        create table public.onchain_event_jobs(id int);
        create table public.fx_rates(network text,payment_mint text,kind text,eur_per_token numeric,decimals int,source text,
          as_of timestamptz,max_age interval,updated_by text,updated_at timestamptz,override_auto boolean);
        create table public.fx_auto_rates(network text,payment_mint text,eur_per_token numeric,decimals int,source text,quotes jsonb,
          as_of timestamptz,max_age interval,updated_at timestamptz);
        create table public.fx_rate_observations(observed_at timestamptz,network text,payment_mint text,status text,code text,eur_per_token numeric);
        create function public.record_fx_auto_rate(text,text,numeric,integer,text,jsonb,integer) returns jsonb language sql as 'select null::jsonb';
        create function public.fx_effective_rate(text,text) returns setof public.fx_rates language sql as 'select * from public.fx_rates where false';
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
    expect(() => db.query(ASSERT + "\n" + FX, vars("devnet", ORIGIN))).toThrow(/Install scripts\/ops\/retry-scheduler.sql first/);
  });

  it("installs one disabled every-minute job on the single-row worker target, and refuses another origin or network", () => {
    db.query(ASSERT + "\n" + RETRY, vars("devnet", ORIGIN));
    db.query(ASSERT + "\n" + FX, vars("devnet", ORIGIN));
    expect(db.query("select jobname||'|'||schedule||'|'||active from cron.job where jobname like 'mancipatio-fx-%'"))
      .toBe("mancipatio-fx-devnet|* * * * *|false");
    // Re-running keeps exactly one disabled job.
    db.query(ASSERT + "\n" + FX, vars("devnet", ORIGIN));
    expect(db.query("select count(*) from cron.job where jobname = 'mancipatio-fx-devnet'")).toBe("1");
    expect(() => db.query(ASSERT + "\n" + FX, vars("devnet", "https://other.manci.io"))).toThrow(/is not the target's siteOrigin/);
    expect(() => db.query(ASSERT + "\n" + FX, vars("mainnet", ORIGIN))).toThrow(/Target mismatch/);
  });

  it("records fixed states and codes only; a refusal is a complete run; another network or a failure is not", () => {
    const ok = run();
    expect(ok).toMatchObject({ ok: true, outcome: "complete", refresh_state: "accepted", code: null, http_status: 200 });
    expect(JSON.stringify(ok)).not.toMatch(/DO_NOT_PERSIST|Bearer|0\.88895/);
    expect(db.query("select last_uri from extensions.mock_response")).toBe(`${ORIGIN}/api/internal/fx`);
    db.query(`update extensions.mock_response set body='${reply("devnet", { status: "refused", code: "ECB_DEVIATION" })}'`);
    expect(run()).toMatchObject({ ok: true, outcome: "complete", refresh_state: "refused", code: "ECB_DEVIATION" });
    db.query(`update extensions.mock_response set body='${reply("devnet", { status: "skipped", reason: "THROTTLED" })}'`);
    expect(run()).toMatchObject({ ok: true, outcome: "complete", refresh_state: "skipped", code: "THROTTLED" });
    db.query(`update extensions.mock_response set body='${reply("mainnet")}'`);
    expect(run()).toMatchObject({ ok: false, outcome: "invalid_response", refresh_state: null });
    db.query(`update extensions.mock_response set status=503, body='${reply("devnet", { status: "failed", error: "DB_ERROR" })}'`);
    expect(run()).toMatchObject({ ok: false, outcome: "http_error", refresh_state: "failed", code: "DB_ERROR" });
    db.query(`update extensions.mock_response set status=401, body='{"ok":false,"error":"Unauthorized"}'`);
    expect(run()).toMatchObject({ ok: false, outcome: "http_error", refresh_state: null });
  });

  it("is private to its operator; the status SQL reads it", () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(() => db.query(`set role ${role};select * from mancipatio_ops.fx_http_runs`)).toThrow(/permission denied/);
      expect(() => db.query(`set role ${role};select mancipatio_ops.invoke_fx_refresh()`)).toThrow(/permission denied/);
    }
    expect(() => db.query(STATUS)).not.toThrow();
  });
});
