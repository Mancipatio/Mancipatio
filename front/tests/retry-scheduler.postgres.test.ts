import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
import { applyMigrations, TEST_PROJECT_REFS } from "./helpers/migrations";

// scripts/ops/retry-scheduler.sql the way db.sh runs it: assert-target.sql
// first in the same psql session, with the target's psql variables. The
// native HTTP and cron interfaces are modelled; the actual transport is
// checked separately against the installed Supabase http extension and the
// live worker.
const ORIGINS = { devnet: "https://www.manci.io", mainnet: "https://mainnet.manci.test" } as const;
type Net = keyof typeof ORIGINS;
const other = (network: Net): Net => (network === "devnet" ? "mainnet" : "devnet");
const ASSERT = readFileSync(join(process.cwd(), "scripts/ops/assert-target.sql"), "utf8");
const INSTALL = readFileSync(join(process.cwd(), "scripts/ops/retry-scheduler.sql"), "utf8").replace(/^create extension .*;$/gm, "");
const success = (network: string) => ({ ok: true, data: { network, status: "processed", indexer: { counts: { complete: 2, pending: 1, invalid: 0 } }, purchases: { counts: { complete: 3, pending: 0, invalid: 1 } } }, privateExtra: "DO_NOT_PERSIST_RESPONSE" });

function platform(db: LocalPostgres, network: Net) {
  db.query(`create role anon;create role authenticated;create role service_role;
    create schema vault;create schema extensions;create schema cron;
    create table public.purchase_evidence_jobs(id int,network text,status text);create table public.indexer_jobs(id int,network text,status text);
    create table public.distribution_plans(id int);
    create table public.indexer_sync_state(network text,status text,completed_at timestamptz,checked_at timestamptz);
    create table vault.secrets(name text primary key,decrypted_secret text);
    insert into vault.secrets values('mancipatio_retry_worker_${network}',repeat('x',64));
    create view vault.decrypted_secrets as select * from vault.secrets;
    -- pg_cron keys named jobs by (jobname, username); scheduling an existing
    -- name for the same user updates schedule and command in place.
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
    create table extensions.mock_response(status integer,body text,failure text,last_options jsonb,last_uri text);
    create table extensions.curl_options(name text,value text);
    create function extensions.http_reset_curlopt() returns boolean language plpgsql as $$ begin delete from extensions.curl_options;return true;end;$$;
    create function extensions.http_set_curlopt(n text,v text) returns boolean language plpgsql as $$ begin insert into extensions.curl_options values(n,v);return true;end;$$;
    create function extensions.http(r extensions.http_request) returns extensions.http_response language plpgsql as $$ declare m record;begin
      if r.method<>'POST' or r.content_type<>'application/json' or r.content<>'{}'
        or (r.headers[1]).field<>'Authorization' or (r.headers[1]).value<>'Bearer '||repeat('x',64) then raise exception 'Unexpected request';end if;
      update extensions.mock_response set last_options=(select jsonb_object_agg(name,value) from extensions.curl_options),last_uri=r.uri;
      select * into m from extensions.mock_response;
      if m.failure='timeout' then raise exception 'PRIVATE_EXCEPTION' using errcode='57014';end if;
      if m.failure='transport' then raise exception 'PRIVATE_EXCEPTION';end if;
      return (m.status,'application/json',array[]::extensions.http_header[],m.body)::extensions.http_response;
    end;$$;`);
  applyMigrations(db, { network, files: ["0070_deployment_identity.sql"] });
}

const vars = (network: string, origin: string, ref = TEST_PROJECT_REFS[network as Net]) =>
  ({ target_network: network, target_ref: ref, target_origin: origin, bootstrap: "0" });
const install = (db: LocalPostgres, network: string, origin: string) => db.query(ASSERT + "\n" + INSTALL, vars(network, origin));

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1").each(["devnet", "mainnet"] as const)(
  "private synchronous retry scheduler SQL on a %s project",
  (network) => {
    const db = new LocalPostgres();
    const run = () => { db.query("select mancipatio_ops.invoke_retry_worker()"); return JSON.parse(db.query("select row_to_json(r) from mancipatio_ops.retry_http_runs r")); };
    beforeAll(() => {
      try {
        db.initialize();
        platform(db, network);
        install(db, network, ORIGINS[network]);
      } catch (error) {
        db.close();
        throw error;
      }
    }, 30_000);
    afterAll(() => db.close());
    beforeEach(() => {
      db.query(`truncate extensions.mock_response,mancipatio_ops.retry_http_runs;update vault.secrets set decrypted_secret=repeat('x',64);
        insert into extensions.mock_response(status,body) values(200,'${JSON.stringify(success(network))}');`);
    });

    it("installs the job for this network, disabled, with an outer statement deadline and the target's origin", () => {
      expect(db.query("select jobname||'|'||active from cron.job")).toBe(`mancipatio-retry-${network}|false`);
      expect(db.query("select command from cron.job")).toContain("statement_timeout='60s'");
      expect(db.query("select command from cron.job")).toContain("mancipatio_ops.invoke_retry_worker()");
      expect(db.query("select network||'|'||origin from mancipatio_ops.retry_worker_config")).toBe(`${network}|${ORIGINS[network]}`);
    });

    it("calls the configured origin and keeps only validated HTTP status and numeric counts, with bounded TLS transport", () => {
      const row = run();
      expect(row).toMatchObject({ ok: true, outcome: "complete", http_status: 200, worker_state: "processed", indexer_complete: 2, purchases_complete: 3 });
      expect(JSON.stringify(row)).not.toMatch(/DO_NOT_PERSIST|Bearer|PRIVATE_EXCEPTION/);
      expect(db.query("select last_uri from extensions.mock_response")).toBe(`${ORIGINS[network]}/api/internal/retry?limit=10`);
      expect(JSON.parse(db.query("select last_options from extensions.mock_response"))).toEqual({ CURLOPT_TIMEOUT_MS: "55000", CURLOPT_CONNECTTIMEOUT: "5", CURLOPT_SSL_VERIFYHOST: "2", CURLOPT_SSL_VERIFYPEER: "1" });
    });

    it.each(["anon", "authenticated", "service_role"])("denies %s the ledger, the config and invocation", (role) => {
      expect(() => db.query(`set role ${role};select * from mancipatio_ops.retry_http_runs`)).toThrow(/permission denied/);
      expect(() => db.query(`set role ${role};select * from mancipatio_ops.retry_worker_config`)).toThrow(/permission denied/);
      expect(() => db.query(`set role ${role};select mancipatio_ops.invoke_retry_worker()`)).toThrow(/permission denied/);
    });

    it("rejects a successful HTTP response bound to the other network", () => {
      db.query(`update extensions.mock_response set body='${JSON.stringify(success(other(network)))}'`);
      expect(run()).toMatchObject({ ok: false, outcome: "invalid_response", http_status: 200 });
    });

    it("does not store raw failures or response contents", () => {
      db.query("update extensions.mock_response set status=401,body='PRIVATE_RESPONSE'");
      expect(run()).toMatchObject({ ok: false, outcome: "http_error", http_status: 401 });
      db.query("truncate mancipatio_ops.retry_http_runs;update extensions.mock_response set status=200,body='PRIVATE_RESPONSE'");
      expect(run()).toMatchObject({ ok: false, outcome: "invalid_response", http_status: 200 });
    });

    it.each(["timeout", "transport"])("records a sanitized %s failure", (kind) => {
      db.query(`update extensions.mock_response set failure='${kind}'`);
      const row = run();
      expect(row).toMatchObject({ ok: false, outcome: kind === "timeout" ? "timeout" : "transport_error", http_status: null });
      expect(JSON.stringify(row)).not.toContain("PRIVATE_EXCEPTION");
    });

    it("fails closed before transport if the Vault credential is invalid", () => {
      db.query("update vault.secrets set decrypted_secret='short'");
      expect(run()).toMatchObject({ ok: false, outcome: "configuration_error", http_status: null });
      expect(db.query("select last_options is null from extensions.mock_response")).toBe("t");
    });

    it("fails closed before transport if the stored config names another network", () => {
      db.query(`update mancipatio_ops.retry_worker_config set network='${other(network)}'`);
      try {
        expect(run()).toMatchObject({ ok: false, outcome: "configuration_error", http_status: null });
        expect(db.query("select last_uri is null from extensions.mock_response")).toBe("t");
      } finally {
        db.query(`update mancipatio_ops.retry_worker_config set network='${network}'`);
      }
    });

    it.each([
      ["no origin", "-", /no valid siteOrigin/],
      ["a plain-http origin", "http://www.manci.io", /no valid siteOrigin/],
      ["an origin with a path", "https://www.manci.io/app", /no valid siteOrigin/],
    ])("refuses to install with %s, changing nothing", (_label, origin, message) => {
      expect(() => install(db, network, origin)).toThrow(message);
      expect(db.query("select origin from mancipatio_ops.retry_worker_config")).toBe(ORIGINS[network]);
    });

    it("refuses another target's network, and a run outside db.sh", () => {
      // assert-target.sql stops a mismatched target first.
      expect(() => install(db, other(network), ORIGINS[other(network)])).toThrow(/Target mismatch/);
      // Without db.sh's session settings the install refuses on its own.
      expect(() => db.query(INSTALL, { target_origin: ORIGINS[network] })).toThrow(/Run this file through scripts\/db.sh/);
    });

    it("status and preflight SQL read this network's job and config", () => {
      const status = db.query(readFileSync(join(process.cwd(), "scripts/ops/retry-scheduler-status.sql"), "utf8"));
      expect(status).toContain(`mancipatio-retry-${network}`);
      // jobid|jobname|username|schedule|active|command_ok
      expect(status.split("\n")[0]).toBe(`1|mancipatio-retry-${network}|postgres|* * * * *|f|t`);
      expect(status).toContain(ORIGINS[network]);
      const preflight = JSON.parse(db.query(readFileSync(join(process.cwd(), "scripts/preflight/supabase-readonly-worker-status.sql"), "utf8")));
      expect(preflight).toMatchObject({
        network,
        job: { name: `mancipatio-retry-${network}`, active: false },
        config: { network, origin: ORIGINS[network] },
        transport: "synchronous_http",
      });
      expect(preflight).not.toHaveProperty("legacy_net_endpoint_queue_rows");
      const identity = JSON.parse(db.query(readFileSync(join(process.cwd(), "scripts/preflight/supabase-readonly-identity.sql"), "utf8")));
      expect(identity.identity).toMatchObject({ network });
      expect(identity.retry_worker_config).toMatchObject({ network, origin: ORIGINS[network] });
    });
  },
);

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("retry scheduler: legacy devnet install upgrade", () => {
  const db = new LocalPostgres();
  beforeAll(() => {
    try {
      db.initialize();
      platform(db, "devnet");
      // The pre-4.3 install: a devnet-only function and an ACTIVE job under the same name.
      db.query(`create schema if not exists mancipatio_ops;
        create function mancipatio_ops.invoke_retry_worker_devnet() returns bigint language sql as 'select 1::bigint';
        insert into cron.job values(1,'mancipatio-retry-devnet','* * * * *','set statement_timeout=''60s''; select mancipatio_ops.invoke_retry_worker_devnet();',true);`);
    } catch (error) {
      db.close();
      throw error;
    }
  }, 30_000);
  afterAll(() => db.close());

  // The install checks cron.job itself before commit, so a job the model
  // above would not produce still stops it: nothing changes.
  it.each([
    ["the same job name under another role", "mancipatio-retry-devnet", "supabase_admin", /Expected exactly one disabled mancipatio-retry-devnet job/],
    ["another job calling the legacy function", "mancipatio-retry-devnet-old", "postgres", /still calls mancipatio_ops\.invoke_retry_worker_devnet/],
  ])("refuses and rolls back with %s", (_label, jobname, username, message) => {
    db.query(`insert into cron.job values(7,'${jobname}','* * * * *','select mancipatio_ops.invoke_retry_worker_devnet();',true,'${username}')`);
    try {
      expect(() => install(db, "devnet", ORIGINS.devnet)).toThrow(message);
      expect(db.query("select to_regprocedure('mancipatio_ops.invoke_retry_worker_devnet()') is not null")).toBe("t");
      expect(db.query("select to_regclass('mancipatio_ops.retry_worker_config') is null")).toBe("t");
      expect(db.query("select string_agg(jobid||'|'||active||'|'||command,';' order by jobid) from cron.job")).toBe(
        "1|true|set statement_timeout='60s'; select mancipatio_ops.invoke_retry_worker_devnet();;" +
        "7|true|select mancipatio_ops.invoke_retry_worker_devnet();",
      );
    } finally {
      db.query("delete from cron.job where jobid=7");
    }
  });

  it("drops the devnet-only function, rewrites the job command in place and leaves the job disabled", () => {
    install(db, "devnet", ORIGINS.devnet);
    expect(db.query("select to_regprocedure('mancipatio_ops.invoke_retry_worker_devnet()') is null")).toBe("t");
    expect(db.query("select count(*)||'|'||min(jobid)||'|'||bool_or(active) from cron.job")).toBe("1|1|false");
    expect(db.query("select command from cron.job")).toBe("set statement_timeout='60s'; select mancipatio_ops.invoke_retry_worker();");
  });
});
