import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
import { applyMigrations, TEST_PROJECT_REFS } from "./helpers/migrations";

// scripts/ops/fx-scheduler.sql (0080) the way db.sh runs it
// (assert-target.sql first), after the retry scheduler whose single-row
// worker target it uses. pg_cron, Vault and the http extension are modelled,
// as in sanctions-scheduler.postgres.test.ts; migration 0080 is stubbed by
// the objects the installer checks for (the tables, the writer, the run
// claim and the 0080 resolver, restored before every test), plus what the
// status SQL reads. Every test installs what it needs: any order passes.
const TARGETS = JSON.parse(readFileSync(join(process.cwd(), "scripts/ops/targets.json"), "utf8")) as Record<"devnet" | "mainnet", { siteOrigin: string }>;
const ORIGIN = TARGETS.devnet.siteOrigin;
const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8").replace(/^create extension .*;$/gm, "");
const ASSERT = readFileSync(join(process.cwd(), "scripts/ops/assert-target.sql"), "utf8");
const RETRY = read("scripts/ops/retry-scheduler.sql");
const FX = read("scripts/ops/fx-scheduler.sql");
const STATUS = read("scripts/ops/fx-scheduler-status.sql");
const OFF = read("scripts/ops/fx-auto-off.sql");
const MANUAL_ONLY = read("scripts/ops/fx-manual-only.sql");
const ROUTE = readFileSync(join(process.cwd(), "app/api/internal/fx/route.ts"), "utf8");
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const vars = (network: string, origin: string) => ({ target_network: network, target_ref: TEST_PROJECT_REFS[network as "devnet"], target_origin: origin, bootstrap: "0" });
/** The off switch without its wait (the wait itself is tested with a short one). */
const offVars = (wait = "0", network = "devnet") => ({ ...vars(network, ORIGIN), fx_off_wait_seconds: wait });
const reply = (network: string, data: Record<string, unknown> = { status: "accepted", rate: "0.88895" }) => JSON.stringify({
  ok: data.status !== "failed",
  data: { network, paymentMint: USDC, ...data },
  privateExtra: "DO_NOT_PERSIST",
});
/** The 0080 stubs a test may have changed: the run claim and the resolver (its body reads fx_auto_rates, its comment is 0080's). */
const STUBS_0080 = `
  create or replace function public.claim_fx_auto_run(text,text) returns jsonb language sql as 'select null::jsonb';
  create or replace function public.fx_effective_rate(p_network text, p_payment_mint text) returns setof public.fx_rates language sql
    as 'select * from public.fx_rates where false and exists (select 1 from public.fx_auto_rates)';
  comment on function public.fx_effective_rate(text,text) is 'The EUR rate that counts for a payment mint (0080).';`;

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("fx scheduler SQL on a devnet project", () => {
  const db = new LocalPostgres();
  const run = () => {
    db.query("select mancipatio_ops.invoke_fx_refresh()");
    return JSON.parse(db.query("select row_to_json(r) from mancipatio_ops.fx_http_runs r order by id desc limit 1"));
  };
  /** The retry scheduler (the worker target) and the fx job, installed disabled; re-runnable. */
  const install = () => {
    db.query(ASSERT + "\n" + RETRY, vars("devnet", ORIGIN));
    db.query(ASSERT + "\n" + FX, vars("devnet", ORIGIN));
  };
  const job = () => db.query("select coalesce((select active::text from cron.job where jobname = 'mancipatio-fx-devnet'), 'none')");
  const autoRows = (network = "devnet") => db.query(`select count(*) from public.fx_auto_rates where network = '${network}'`);
  const seedAuto = () => db.query(`insert into public.fx_auto_rates(network,payment_mint,eur_per_token,decimals,source,quotes,as_of,max_age) values
    ('devnet','${USDC}',0.889,6,'auto','{}',now(),'15 minutes'), ('mainnet','${USDC}',0.889,6,'auto','{}',now(),'15 minutes')`);
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
        create table public.fx_rate_observations(observed_at timestamptz,network text,payment_mint text,status text,code text,
          eur_per_token numeric,quotes jsonb);
        create function public.record_fx_auto_rate(text,text,numeric,integer,text,jsonb,integer) returns jsonb language sql as 'select null::jsonb';
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
      db.query(STUBS_0080);
      applyMigrations(db, { network: "devnet", files: ["0070_deployment_identity.sql"] });
    } catch (error) {
      db.close();
      throw error;
    }
  }, 30_000);
  afterAll(() => db.close());
  beforeEach(() => db.query(`truncate extensions.mock_response; insert into extensions.mock_response(status,body) values(200,'${reply("devnet")}');
    truncate public.fx_auto_rates, public.fx_rates; ${STUBS_0080}`));

  it("refuses to install without the whole of 0080 (the run claim too)", () => {
    db.query("drop function public.claim_fx_auto_run(text,text)");
    expect(() => db.query(ASSERT + "\n" + FX, vars("devnet", ORIGIN))).toThrow(/Apply migration 0080 before installing the fx scheduler/);
  });

  it("refuses to install before the retry scheduler's worker target exists", () => {
    const installed = db.query("select to_regclass('mancipatio_ops.retry_worker_config') is not null") === "t";
    if (installed) db.query("alter table mancipatio_ops.retry_worker_config rename to retry_worker_config_hidden");
    try {
      expect(() => db.query(ASSERT + "\n" + FX, vars("devnet", ORIGIN))).toThrow(/Install scripts\/ops\/retry-scheduler.sql first/);
    } finally {
      if (installed) db.query("alter table mancipatio_ops.retry_worker_config_hidden rename to retry_worker_config");
    }
  });

  it("installs one disabled every-minute job on the single-row worker target, and refuses another origin or network", () => {
    install();
    expect(db.query("select jobname||'|'||schedule||'|'||active from cron.job where jobname like 'mancipatio-fx-%'"))
      .toBe("mancipatio-fx-devnet|* * * * *|false");
    // Re-running keeps exactly one disabled job.
    db.query(ASSERT + "\n" + FX, vars("devnet", ORIGIN));
    expect(db.query("select count(*) from cron.job where jobname = 'mancipatio-fx-devnet'")).toBe("1");
    expect(() => db.query(ASSERT + "\n" + FX, vars("devnet", "https://other.manci.io"))).toThrow(/is not the target's siteOrigin/);
    expect(() => db.query(ASSERT + "\n" + FX, vars("mainnet", ORIGIN))).toThrow(/Target mismatch/);
  });

  it("refuses to (re)install over the manual-only resolver until 0080 is re-applied (marker or body)", () => {
    install();
    db.query(ASSERT + "\n" + MANUAL_ONLY, vars("devnet", ORIGIN));
    expect(db.query("select obj_description('public.fx_effective_rate(text,text)'::regprocedure, 'pg_proc') like 'manci:fx-manual-only%'")).toBe("t");
    expect(() => db.query(ASSERT + "\n" + FX, vars("devnet", ORIGIN)))
      .toThrow(/manual-only resolver .*re-apply supabase\/migrations\/0080_fx_auto_rates.sql first/);
    // Without the marker (an edited comment, an older manual-only file) the body still gives it away.
    db.query("comment on function public.fx_effective_rate(text,text) is 'Manual-only (rollback of 0080)'");
    expect(() => db.query(ASSERT + "\n" + FX, vars("devnet", ORIGIN))).toThrow(/manual-only resolver/);
    // Re-applying 0080 (here its stub: the resolver reads fx_auto_rates, its comment is 0080's) lets it install again.
    db.query(STUBS_0080);
    install();
    expect(job()).toBe("false");
  });

  it("records fixed states and codes only; a refusal is a complete run; another network or a failure is not", () => {
    install();
    const ok = run();
    expect(ok).toMatchObject({ ok: true, outcome: "complete", refresh_state: "accepted", code: null, http_status: 200 });
    expect(JSON.stringify(ok)).not.toMatch(/DO_NOT_PERSIST|Bearer|0\.88895/);
    expect(db.query("select last_uri from extensions.mock_response")).toBe(`${ORIGIN}/api/internal/fx`);
    db.query(`update extensions.mock_response set body='${reply("devnet", { status: "refused", code: "ECB_DEVIATION" })}'`);
    expect(run()).toMatchObject({ ok: true, outcome: "complete", refresh_state: "refused", code: "ECB_DEVIATION" });
    db.query(`update extensions.mock_response set body='${reply("devnet", { status: "refused", code: "INVALID_FX_RATE" })}'`);
    expect(run()).toMatchObject({ ok: true, outcome: "complete", refresh_state: "refused", code: "INVALID_FX_RATE" });
    db.query(`update extensions.mock_response set body='${reply("devnet", { status: "skipped", reason: "THROTTLED" })}'`);
    expect(run()).toMatchObject({ ok: true, outcome: "complete", refresh_state: "skipped", code: "THROTTLED" });
    db.query(`update extensions.mock_response set body='${reply("mainnet")}'`);
    expect(run()).toMatchObject({ ok: false, outcome: "invalid_response", refresh_state: null });
    db.query(`update extensions.mock_response set status=503, body='${reply("devnet", { status: "failed", error: "DB_ERROR" })}'`);
    expect(run()).toMatchObject({ ok: false, outcome: "http_error", refresh_state: "failed", code: "DB_ERROR" });
    db.query(`update extensions.mock_response set status=503, body='${reply("devnet", { status: "failed", error: "INVALID_FX_RATE" })}'`);
    expect(run()).toMatchObject({ ok: false, outcome: "http_error", refresh_state: "failed", code: "INVALID_FX_RATE" });
    db.query(`update extensions.mock_response set status=401, body='{"ok":false,"error":"Unauthorized"}'`);
    expect(run()).toMatchObject({ ok: false, outcome: "http_error", refresh_state: null });
  });

  it("the off switch disables the job AND deletes this network's automatic rows; manual-only waits for the whole of it", () => {
    install();
    db.query("select cron.alter_job(jobid, active := true) from cron.job where jobname = 'mancipatio-fx-devnet'");
    seedAuto();
    db.query(`insert into public.fx_rates(network,payment_mint,kind,eur_per_token,decimals,source,as_of,max_age,override_auto)
      values ('devnet','${USDC}','rate',0.9,6,'manual',now(),'7 days',false)`);
    // The optional manual-only resolver refuses while the job still runs ...
    expect(() => db.query(ASSERT + "\n" + MANUAL_ONLY, vars("devnet", ORIGIN))).toThrow(/run scripts\/ops\/fx-auto-off.sql first/);
    // ... and while automatic rows are left (half an off switch: only the job disabled).
    db.query("select cron.alter_job(jobid, active := false) from cron.job where jobname = 'mancipatio-fx-devnet'");
    expect(() => db.query(ASSERT + "\n" + MANUAL_ONLY, vars("devnet", ORIGIN)))
      .toThrow(/still holds this network's automatic rates: run the whole off switch/);
    db.query("select cron.alter_job(jobid, active := true) from cron.job where jobname = 'mancipatio-fx-devnet'");
    const out = db.query(ASSERT + "\n" + OFF, offVars());
    expect(out).toContain("mancipatio-fx-devnet active=false|0");
    expect(out).toMatch(/4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU\|rate\|0\.9\|.*\|t$/m);
    expect(db.query("select string_agg(network, ',') from public.fx_auto_rates")).toBe("mainnet");
    // Re-running is harmless.
    expect(db.query(ASSERT + "\n" + OFF, offVars())).toContain("mancipatio-fx-devnet active=false|0");
    db.query(ASSERT + "\n" + MANUAL_ONLY, vars("devnet", ORIGIN));
    expect(db.query(`select eur_per_token||'|'||source from public.fx_effective_rate('devnet','${USDC}')`)).toBe("0.9|manual");
    expect(() => db.query(ASSERT + "\n" + OFF, offVars("0", "mainnet"))).toThrow(/Target mismatch/);
  });

  it("off switch: the job is disabled and committed BEFORE the wait; a run still in flight that writes meanwhile is deleted", async () => {
    install();
    db.query("select cron.alter_job(jobid, active := true) from cron.job where jobname = 'mancipatio-fx-devnet'");
    seedAuto();
    const off = db.queryAsync(ASSERT + "\n" + OFF, offVars("2"));
    // Transaction 1 commits first: the job is seen disabled while the file still waits.
    const until = Date.now() + 2_500;
    while (job() !== "false" && Date.now() < until) db.query("select pg_sleep(0.05)");
    expect(job()).toBe("false");
    // A run that started before the disable records now (the upsert the race was about).
    db.query(`update public.fx_auto_rates set eur_per_token = 0.8891, as_of = now() where network = 'devnet'`);
    expect(autoRows()).toBe("1");
    expect(await off).toContain("mancipatio-fx-devnet active=false|0");
    expect(autoRows()).toBe("0");
    expect(autoRows("mainnet")).toBe("1");
  }, 30_000);

  it("off switch: a row that reappears or a job enabled again after the delete fails loudly; running it again ends off", () => {
    install();
    db.query("select cron.alter_job(jobid, active := true) from cron.job where jobname = 'mancipatio-fx-devnet'");
    seedAuto();
    // A late write committing right behind the delete (modelled by a trigger on the delete itself).
    db.query(`create function public.late_fx_write() returns trigger language plpgsql as $$ begin
        insert into public.fx_auto_rates(network,payment_mint,eur_per_token,decimals,source,quotes,as_of,max_age)
          values ('devnet','${USDC}',0.8892,6,'auto','{}',now(),'15 minutes');
        return null; end $$;
      create trigger late_fx_write after delete on public.fx_auto_rates for each statement execute function public.late_fx_write()`);
    try {
      expect(() => db.query(ASSERT + "\n" + OFF, offVars()))
        .toThrow(/NOT off: an automatic rate reappeared after the delete.*Run scripts\/ops\/fx-auto-off.sql again/);
    } finally {
      db.query("drop trigger late_fx_write on public.fx_auto_rates; drop function public.late_fx_write()");
    }
    expect(autoRows()).toBe("1");
    expect(job()).toBe("false");
    // Someone enables the job again while it runs.
    db.query(`create function public.reenable_fx_job() returns trigger language plpgsql as $$ begin
        update cron.job set active = true where jobname = 'mancipatio-fx-devnet'; return null; end $$;
      create trigger reenable_fx_job after delete on public.fx_auto_rates for each statement execute function public.reenable_fx_job()`);
    try {
      expect(() => db.query(ASSERT + "\n" + OFF, offVars())).toThrow(/NOT off: mancipatio-fx-devnet was enabled again/);
    } finally {
      db.query("drop trigger reenable_fx_job on public.fx_auto_rates; drop function public.reenable_fx_job()");
    }
    // Running it again: off.
    expect(db.query(ASSERT + "\n" + OFF, offVars())).toContain("mancipatio-fx-devnet active=false|0");
    expect(autoRows()).toBe("0");
  });

  it("off switch: the default wait outlasts a run in flight (the job's statement timeout, its HTTP timeout, the route's maxDuration)", () => {
    const wait = Number(/\\set fx_off_wait_seconds (\d+)/.exec(OFF)?.[1]);
    const statementTimeout = Number(/statement_timeout=''(\d+)s''/.exec(FX)?.[1]);
    const httpTimeout = Number(/'CURLOPT_TIMEOUT_MS','(\d+)'/.exec(FX)?.[1]) / 1000;
    const maxDuration = Number(/export const maxDuration = (\d+);/.exec(ROUTE)?.[1]);
    expect([statementTimeout, httpTimeout, maxDuration]).toEqual([30, 25, 30]);
    expect(wait).toBeGreaterThan(Math.max(statementTimeout, httpTimeout, maxDuration));
    // The wait cannot be cut short by a role's default statement timeout.
    expect(OFF).toMatch(/set statement_timeout = '330s';\nselect pg_catalog\.pg_sleep\(greatest\(0, least\(300,/);
  });

  it("is private to its operator; the status SQL reads it (the ECB deviation next to its band)", () => {
    install();
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(() => db.query(`set role ${role};select * from mancipatio_ops.fx_http_runs`)).toThrow(/permission denied/);
      expect(() => db.query(`set role ${role};select mancipatio_ops.invoke_fx_refresh()`)).toThrow(/permission denied/);
    }
    db.query(`insert into public.fx_auto_rates(network,payment_mint,eur_per_token,decimals,source,quotes,as_of,max_age) values
      ('devnet','${USDC}',0.889,6,'auto','{"spread_bps":1,"ecb_deviation_bps":22,"ecb_tolerance_bps":250}',now(),'15 minutes')`);
    // The manual rows say whether they are fresh (checked before the off switch).
    db.query(`insert into public.fx_rates(network,payment_mint,kind,eur_per_token,decimals,source,as_of,max_age,override_auto)
      values ('devnet','${USDC}','rate',0.9,6,'Bank quote',now()-interval '8 days','7 days',false)`);
    const status = db.query(STATUS);
    expect(status).toMatch(new RegExp(`^${USDC}\\|0\\.889\\|.*\\|1\\|22\\|250$`, "m"));
    expect(status).toMatch(new RegExp(`^${USDC}\\|rate\\|0\\.9\\|.*\\|7 days\\|f\\|Bank quote\\|f$`, "m"));
  });
});
