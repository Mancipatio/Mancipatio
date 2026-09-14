import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
const db = new LocalPostgres();
const success = { ok: true, data: { network: "devnet", status: "processed", indexer: { counts: { complete: 2, pending: 1, invalid: 0 } }, purchases: { counts: { complete: 3, pending: 0, invalid: 1 } } }, privateExtra: "DO_NOT_PERSIST_RESPONSE" };
describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("private synchronous retry scheduler SQL", () => {
  beforeAll(() => {
    db.initialize();
    db.query(`create role anon;create role authenticated;create role service_role;
      create schema vault;create schema extensions;create schema cron;
      create table public.purchase_evidence_jobs(id int);create table public.indexer_jobs(id int);create table public.distribution_plans(id int);
      create table vault.secrets(name text primary key,decrypted_secret text);
      insert into vault.secrets values('mancipatio_retry_worker_devnet',repeat('x',64));
      create view vault.decrypted_secrets as select * from vault.secrets;
      create table cron.job(jobid bigint primary key,jobname text unique,schedule text,command text,active boolean);
      create function cron.schedule(n text,s text,c text) returns bigint language plpgsql as $$ begin
        insert into cron.job values(1,n,s,c,true) on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command;return 1;end;$$;
      create function cron.alter_job(bigint,active boolean) returns void language sql as $$ update cron.job set active=$2 where jobid=$1 $$;
      create type extensions.http_header as(field varchar,value varchar);
      create type extensions.http_request as(method text,uri varchar,headers extensions.http_header[],content_type varchar,content varchar);
      create type extensions.http_response as(status integer,content_type varchar,headers extensions.http_header[],content varchar);
      create table extensions.mock_response(status integer,body text,failure text,last_options jsonb);
      create table extensions.curl_options(name text,value text);
      create function extensions.http_reset_curlopt() returns boolean language plpgsql as $$ begin delete from extensions.curl_options;return true;end;$$;
      create function extensions.http_set_curlopt(n text,v text) returns boolean language plpgsql as $$ begin insert into extensions.curl_options values(n,v);return true;end;$$;
      create function extensions.http(r extensions.http_request) returns extensions.http_response language plpgsql as $$ declare m record;begin
        if r.uri<>'https://www.mancipatio.io/api/internal/retry?limit=10' or r.method<>'POST'
          or r.content_type<>'application/json' or r.content<>'{}'
          or (r.headers[1]).field<>'Authorization' or (r.headers[1]).value<>'Bearer '||repeat('x',64) then raise exception 'Unexpected request';end if;
        update extensions.mock_response set last_options=(select jsonb_object_agg(name,value) from extensions.curl_options);
        select * into m from extensions.mock_response;
        if m.failure='timeout' then raise exception 'PRIVATE_EXCEPTION' using errcode='57014';end if;
        if m.failure='transport' then raise exception 'PRIVATE_EXCEPTION';end if;
        return (m.status,'application/json',array[]::extensions.http_header[],m.body)::extensions.http_response;
      end;$$;`);
    // Model only the native HTTP/cron interfaces. Actual transport is checked
    // separately against the installed Supabase http extension and live worker.
    const sql = readFileSync("scripts/ops/retry-scheduler.sql", "utf8").replace(/^create extension .*;$/gm, "");
    db.query(sql);
  }, 30_000);
  afterAll(() => db.close());
  beforeEach(() => {
    db.query(`truncate extensions.mock_response,mancipatio_ops.retry_http_runs;update vault.secrets set decrypted_secret=repeat('x',64);
      insert into extensions.mock_response(status,body) values(200,'${JSON.stringify(success)}');`);
  });
  const run = () => { db.query("select mancipatio_ops.invoke_retry_worker_devnet()"); return JSON.parse(db.query("select row_to_json(r) from mancipatio_ops.retry_http_runs r")); };
  it("installs disabled with an outer statement deadline", () => {
    expect(db.query("select active from cron.job")).toBe("f");
    expect(db.query("select command from cron.job")).toContain("statement_timeout='60s'");
  });
  it("keeps only validated HTTP status and numeric counts, with bounded TLS transport", () => {
    const row = run();
    expect(row).toMatchObject({ ok: true, outcome: "complete", http_status: 200, worker_state: "processed", indexer_complete: 2, purchases_complete: 3 });
    expect(JSON.stringify(row)).not.toMatch(/DO_NOT_PERSIST|Bearer|PRIVATE_EXCEPTION/);
    expect(JSON.parse(db.query("select last_options from extensions.mock_response"))).toEqual({ CURLOPT_TIMEOUT_MS: "55000", CURLOPT_CONNECTTIMEOUT: "5", CURLOPT_SSL_VERIFYHOST: "2", CURLOPT_SSL_VERIFYPEER: "1" });
  });
  it.each(["anon", "authenticated", "service_role"])("denies %s both ledger access and invocation", (role) => {
    expect(() => db.query(`set role ${role};select * from mancipatio_ops.retry_http_runs`)).toThrow(/permission denied/);
    expect(() => db.query(`set role ${role};select mancipatio_ops.invoke_retry_worker_devnet()`)).toThrow(/permission denied/);
  });
  it("rejects a successful HTTP response bound to another network", () => {
    db.query("update extensions.mock_response set body=replace(body,'devnet','mainnet')");
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
});
