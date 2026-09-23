import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";

const db = new LocalPostgres();
const migrations = join(process.cwd(), "supabase/migrations");
const retentionMigration = readdirSync(migrations).find((f) => /^\d+_operational_retention\.sql$/.test(f));
const FN = "mancipatio_ops.prune_operational_data";

// Fixtures relative to now(); the labels live in text columns without format checks.
const SEED = `
  truncate public.indexer_jobs, public.purchase_evidence_jobs, public.auth_login_tokens,
    public.auth_google_states, mancipatio_ops.retention_runs;
  delete from public.indexer_events;
  insert into public.indexer_jobs(network, signature, status, created_at, updated_at) values
    ('devnet', 'complete-31d', 'complete', now() - interval '40 days', now() - interval '31 days'),
    ('mainnet', 'complete-45d-mainnet', 'complete', now() - interval '50 days', now() - interval '45 days'),
    ('devnet', 'complete-29d', 'complete', now() - interval '30 days', now() - interval '29 days'),
    ('devnet', 'pending-60d', 'pending', now() - interval '60 days', now() - interval '60 days');
  insert into public.indexer_events(created_at, network, signature, slot, block_time, program, ix_name, decoded, wallets, payload) values
    (now() - interval '91 days', 'devnet', 'event-91d', 100, now() - interval '91 days', 'Prog', 'buy', true, array['Wallet1'],
      '{"accountData":[{"account":"Wallet1"}],"nativeTransfers":[{"amount":5}]}'),
    (now() - interval '89 days', 'devnet', 'event-89d', 200, now() - interval '89 days', 'Prog', 'sell', false, array['Wallet2'], '{"raw":1}'),
    (now() - interval '200 days', 'devnet', 'event-already-empty', 50, null, 'Prog', 'init', true, null, '{}');
  insert into public.purchase_evidence_jobs(network, buyer, sale_pubkey, signature, status, created_at, updated_at) values
    ('devnet', 'Buyer1', 'Sale1', 'purchase-complete-91d', 'complete', now() - interval '92 days', now() - interval '91 days'),
    ('devnet', 'Buyer1', 'Sale1', 'purchase-invalid-91d', 'invalid', now() - interval '92 days', now() - interval '91 days'),
    ('devnet', 'Buyer1', 'Sale1', 'purchase-pending-120d', 'pending', now() - interval '120 days', now() - interval '120 days'),
    ('devnet', 'Buyer1', 'Sale1', 'purchase-complete-89d', 'complete', now() - interval '90 days', now() - interval '89 days');
  insert into public.auth_login_tokens(token_hash, network, email, created_at, expires_at, consumed_at) values
    (repeat('1', 64), 'devnet', 'expired@x.test', now() - interval '2 hours', now() - interval '100 minutes', null),
    (repeat('2', 64), 'devnet', 'live@x.test', now(), now() + interval '20 minutes', null),
    (repeat('3', 64), 'devnet', 'used-live@x.test', now() - interval '1 minute', now() + interval '19 minutes', now()),
    (repeat('4', 64), 'devnet', 'used-expired@x.test', now() - interval '3 days',
      now() - interval '3 days' + interval '20 minutes', now() - interval '3 days' + interval '1 minute');
  insert into public.auth_google_states(state_hash, browser_hash, network, code_verifier, redirect_uri, created_at, expires_at) values
    (repeat('a', 64), repeat('b', 64), 'devnet', 'v', 'https://expired.test/cb', now() - interval '1 hour', now() - interval '50 minutes'),
    (repeat('c', 64), repeat('d', 64), 'devnet', 'v', 'https://live.test/cb', now(), now() + interval '10 minutes');`;

const SNAPSHOT = `select jsonb_build_object(
  'indexer_jobs', (select jsonb_agg(signature order by signature) from public.indexer_jobs),
  'indexer_events', (select jsonb_agg(jsonb_build_object('signature', signature, 'payload', payload, 'ix_name', ix_name,
    'decoded', decoded, 'wallets', wallets, 'slot', slot, 'has_block_time', block_time is not null) order by signature) from public.indexer_events),
  'purchase_evidence_jobs', (select jsonb_agg(signature order by signature) from public.purchase_evidence_jobs),
  'auth_login_tokens', (select jsonb_agg(email order by email) from public.auth_login_tokens),
  'auth_google_states', (select jsonb_agg(redirect_uri order by redirect_uri) from public.auth_google_states))`;

const snapshot = () => JSON.parse(db.query(SNAPSHOT));
const prune = (args = "") => JSON.parse(db.query(`select ${FN}(${args})`));

describe.skipIf(process.env.RUN_LOCAL_POSTGRES_TESTS !== "1")("operational data retention", () => {
  beforeAll(() => {
    db.initialize();
    try {
      // Same platform model as migration-chain.postgres.test.ts; every
      // application table and function comes from the actual migrations.
      db.query(`create role anon;create role authenticated;create role service_role bypassrls;
        create schema storage;
        create table storage.buckets(id text primary key,name text,public boolean default false,file_size_limit bigint,allowed_mime_types text[]);
        create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text);
        alter table storage.objects enable row level security;
        grant usage on schema public,storage to anon,authenticated,service_role;
        alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
        alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;
        grant all on storage.objects,storage.buckets to service_role;
        grant all on storage.objects to anon,authenticated;`);
      for (const file of readdirSync(migrations).filter((f) => /^\d+.*\.sql$/.test(f)).sort()) {
        db.query(readFileSync(join(migrations, file), "utf8"));
      }
    } catch (error) {
      db.close();
      throw error;
    }
  }, 60_000);
  afterAll(() => db.close());

  it("is a numbered migration that re-applies cleanly", () => {
    expect(retentionMigration).toBeDefined();
    db.query(readFileSync(join(migrations, retentionMigration!), "utf8"));
  });

  it("prunes exactly the expired operational rows and keeps what users and audits read", () => {
    db.query(SEED);
    const result = prune();
    expect(result).toMatchObject({
      indexer_jobs: 2, indexer_event_payloads: 1, purchase_evidence_jobs: 2, auth_login_tokens: 2, auth_google_states: 1,
      cron: "absent", cron_job_run_details: null, more: false, dry_run: false,
    });
    expect(snapshot()).toEqual({
      // Pending work is never pruned, however old; recent completions stay.
      indexer_jobs: ["complete-29d", "pending-60d"],
      indexer_events: [
        { signature: "event-89d", payload: { raw: 1 }, ix_name: "sell", decoded: false, wallets: ["Wallet2"], slot: 200, has_block_time: true },
        // History columns intact; only the raw payload is emptied.
        { signature: "event-91d", payload: {}, ix_name: "buy", decoded: true, wallets: ["Wallet1"], slot: 100, has_block_time: true },
        { signature: "event-already-empty", payload: {}, ix_name: "init", decoded: true, wallets: null, slot: 50, has_block_time: false },
      ],
      purchase_evidence_jobs: ["purchase-complete-89d", "purchase-pending-120d"],
      auth_login_tokens: ["live@x.test", "used-live@x.test"],
      auth_google_states: ["https://live.test/cb"],
    });
    // A second run finds nothing left.
    expect(prune()).toMatchObject({ indexer_jobs: 0, indexer_event_payloads: 0, purchase_evidence_jobs: 0, auth_login_tokens: 0, auth_google_states: 0 });
  });

  it("records counts only for each real run", () => {
    db.query(SEED);
    prune();
    const runs = JSON.parse(db.query("select jsonb_agg(result) from mancipatio_ops.retention_runs"));
    expect(runs).toHaveLength(1);
    expect(Object.keys(runs[0]).sort()).toEqual([
      "auth_google_states", "auth_login_tokens", "cron", "cron_job_run_details", "dry_run", "duration_ms",
      "indexer_event_payloads", "indexer_jobs", "more", "purchase_evidence_jobs",
    ]);
    expect(JSON.stringify(runs)).not.toMatch(/@x\.test|Wallet|Buyer|complete-|event-/);
  });

  it("dry-runs the same counts without changing anything", () => {
    db.query(SEED);
    const before = snapshot();
    const dry = prune("p_dry_run => true");
    expect(snapshot()).toEqual(before);
    expect(db.query("select count(*) from mancipatio_ops.retention_runs")).toBe("0");
    const real = prune();
    const strip = (result: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(result).filter(([key]) => key !== "dry_run" && key !== "duration_ms"));
    expect(dry.dry_run).toBe(true);
    expect(strip(dry)).toEqual(strip(real));
  });

  it("works in bounded batches and reports when a run was capped", () => {
    db.query(`${SEED}
      insert into public.indexer_jobs(network, signature, status, created_at, updated_at)
        select 'devnet', 'bulk-' || i, 'complete', now() - interval '60 days', now() - interval '40 days' from generate_series(1, 3) i;`);
    // 5 eligible jobs: two batches of two, then the cap.
    expect(prune("p_batch_size => 2, p_max_batches => 2")).toMatchObject({ indexer_jobs: 4, more: true });
    expect(prune("p_batch_size => 2, p_max_batches => 2")).toMatchObject({ indexer_jobs: 1, more: false });
    expect(snapshot().indexer_jobs).toEqual(["complete-29d", "pending-60d"]);
  });

  it("skips rows a worker holds instead of waiting for them", async () => {
    db.query(SEED);
    // Hold complete-31d's row lock in a concurrent session for a moment.
    const holder = db.queryAsync(`begin; select 1 from public.indexer_jobs where signature = 'complete-31d' for update; select pg_sleep(1.5); commit;`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const started = Date.now();
    expect(prune()).toMatchObject({ indexer_jobs: 1 });
    expect(Date.now() - started).toBeLessThan(1_000);
    await holder;
    expect(snapshot().indexer_jobs).toEqual(["complete-29d", "complete-31d", "pending-60d"]);
  });

  it("rejects unsafe parameters", () => {
    for (const args of ["p_batch_size => 0", "p_batch_size => 50001", "p_max_batches => 0", "p_max_batches => 1001", "p_dry_run => null"]) {
      expect(() => db.query(`select ${FN}(${args})`)).toThrow(/Invalid retention parameters/);
    }
  });

  it("is a private security-definer operation with a fixed search path", () => {
    expect(db.query(`select prosecdef from pg_proc where oid = '${FN}(integer,integer,boolean)'::regprocedure`)).toBe("t");
    expect(db.query(`select array_to_string(proconfig, ',') from pg_proc where oid = '${FN}(integer,integer,boolean)'::regprocedure`))
      .toBe('search_path="",lock_timeout=5s');
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(() => db.query(`set role ${role};select ${FN}()`)).toThrow(/permission denied/);
      expect(() => db.query(`set role ${role};select * from mancipatio_ops.retention_runs`)).toThrow(/permission denied/);
      expect(db.query(`select has_function_privilege('${role}', '${FN}(integer,integer,boolean)', 'EXECUTE')`)).toBe("f");
    }
  });

  it("prunes pg_cron history after 7 days once pg_cron exists", () => {
    db.query(`create schema cron;
      create table cron.job(jobid bigint primary key, jobname text unique, schedule text, command text, active boolean);
      create table cron.job_run_details(runid bigserial primary key, jobid bigint, status text, return_message text,
        start_time timestamptz, end_time timestamptz);
      insert into cron.job_run_details(jobid, status, return_message, start_time, end_time) values
        (1, 'succeeded', 'old', now() - interval '8 days', now() - interval '8 days' + interval '1 second'),
        (1, 'failed', 'old-unfinished', now() - interval '9 days', null),
        (1, 'succeeded', 'recent', now() - interval '6 days', now() - interval '6 days' + interval '1 second'),
        (1, 'running', 'now', now(), null);`);
    db.query(SEED);
    expect(prune()).toMatchObject({ cron: "pruned", cron_job_run_details: 2, indexer_jobs: 2 });
    expect(db.query("select string_agg(return_message, ',' order by runid) from cron.job_run_details")).toBe("recent,now");
  });

  describe("daily scheduler", () => {
    const script = () => readFileSync("scripts/ops/retention-scheduler.sql", "utf8").replace(/^create extension .*;$/gm, "");
    beforeAll(() => {
      // Model only pg_cron's scheduling interface (cron schema created above).
      db.query(`create function cron.schedule(n text, s text, c text) returns bigint language plpgsql as $$ begin
          insert into cron.job values (7, n, s, c, true) on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command;
          return 7; end; $$;
        create function cron.alter_job(bigint, active boolean) returns void language sql as $$ update cron.job set active = $2 where jobid = $1 $$;`);
    });

    it("installs one network-agnostic daily job, disabled, with an outer deadline", () => {
      const sql = script();
      expect(sql.replace(/--.*$/gm, "")).not.toMatch(/devnet|mainnet|testnet|localnet|https?:\/\/|vault|secret/i);
      db.query(sql);
      expect(db.query("select jobname || '|' || schedule || '|' || active from cron.job")).toBe("mancipatio-retention|17 3 * * *|false");
      const command = db.query("select command from cron.job where jobname = 'mancipatio-retention'");
      expect(command).toContain("statement_timeout='300s'");
      expect(command).toContain(`select ${FN}();`);
    });

    it("re-installs disabled after an operator enabled it", () => {
      db.query("update cron.job set active = true where jobname = 'mancipatio-retention'");
      db.query(script());
      expect(db.query("select active from cron.job where jobname = 'mancipatio-retention'")).toBe("f");
      expect(db.query("select count(*) from cron.job")).toBe("1");
    });

    it("refuses to install while the operation is exposed", () => {
      db.query(`grant usage on schema mancipatio_ops to anon`);
      try {
        expect(() => db.query(script())).toThrow(/exposed/);
      } finally {
        db.query(`revoke usage on schema mancipatio_ops from anon`);
      }
      db.query(`grant execute on function ${FN}(integer,integer,boolean) to service_role`);
      try {
        expect(() => db.query(script())).toThrow(/exposed/);
      } finally {
        db.query(`revoke execute on function ${FN}(integer,integer,boolean) from service_role`);
      }
    });

    it("reports status with a dry run and changes nothing", () => {
      db.query(SEED);
      const before = snapshot();
      const output = db.query(readFileSync("scripts/ops/retention-scheduler-status.sql", "utf8"));
      expect(output).toContain("mancipatio-retention");
      expect(output).toContain('"dry_run": true');
      expect(snapshot()).toEqual(before);
      expect(db.query("select count(*) from mancipatio_ops.retention_runs")).toBe("0");
    });
  });
});
