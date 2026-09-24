import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalPostgres } from "./helpers/local-postgres";
import { applyMigrations } from "./helpers/migrations";

const db = new LocalPostgres();
const migrations = join(process.cwd(), "supabase/migrations");
const retentionMigration = readdirSync(migrations).find((f) => /^\d+_operational_retention\.sql$/.test(f));
const PROC = "mancipatio_ops.prune_operational_data";
const PREVIEW = "mancipatio_ops.retention_preview";
const PROC_SIG = `${PROC}(integer,integer,integer)`;

// Fixtures relative to now(); the labels live in text columns without format checks.
const SEED = `
  truncate public.indexer_jobs, public.purchase_evidence_jobs, public.auth_login_tokens,
    public.auth_google_states, mancipatio_ops.retention_runs;
  delete from public.indexer_events;
  insert into public.indexer_jobs(network, signature, status, created_at, updated_at) values
    ('devnet', 'complete-31d', 'complete', now() - interval '40 days', now() - interval '31 days'),
    ('testnet', 'complete-45d-testnet', 'complete', now() - interval '50 days', now() - interval '45 days'),
    ('devnet', 'complete-29d', 'complete', now() - interval '30 days', now() - interval '29 days'),
    ('devnet', 'pending-60d', 'pending', now() - interval '60 days', now() - interval '60 days');
  insert into public.indexer_events(created_at, network, signature, slot, block_time, program, ix_name, decoded, wallets, payload) values
    (now() - interval '91 days', 'devnet', 'event-91d', 100, now() - interval '91 days', 'Prog', 'buy', true, array['Wallet1'],
      '{"accountData":[{"account":"Wallet1"}],"nativeTransfers":[{"amount":5}]}'),
    (now() - interval '89 days', 'devnet', 'event-89d', 200, now() - interval '89 days', 'Prog', 'sell', false, array['Wallet2'], '{"raw":1}'),
    (now() - interval '200 days', 'devnet', 'event-already-empty', 50, null, 'Prog', 'init', true, null, '{}'),
    -- Written before 0039: no wallets column yet, so the payload is the only
    -- source a wallets backfill could use.
    (now() - interval '300 days', 'devnet', 'event-pre-0039', 40, now() - interval '300 days', 'Prog', 'buy', true, null, '{"accountData":[{"account":"Wallet3"}]}'),
    -- Its job is still pending: the raw webhook is needed to debug it.
    (now() - interval '95 days', 'devnet', 'event-undecoded-95d', 60, now() - interval '95 days', 'Prog', 'buy', false, array['Wallet4'], '{"raw":2}');
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
const LAST_RUN = "select result from mancipatio_ops.retention_runs order by id desc limit 1";
/** One real run (a bare top-level CALL, as pg_cron issues it) and its recorded counts. */
const prune = (args = "") => {
  db.query(`call ${PROC}(${args})`);
  return JSON.parse(db.query(LAST_RUN));
};
const preview = (args = "") => JSON.parse(db.query(`select ${PREVIEW}(${args})`));
const TASKS = ["indexer_jobs", "indexer_event_payloads", "purchase_evidence_jobs", "auth_login_tokens", "auth_google_states", "cron_job_run_details", "onchain_event_jobs"];
// 0072 redefines retention_tasks() with task 7 (onchain_event_jobs, 90 days).
const ALARMS_MIGRATION = "0072_onchain_alarms.sql";
const taskCounts = (result: Record<string, unknown>) => Object.fromEntries(TASKS.map((task) => [task, result[task]]));

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
      applyMigrations(db, { network: "devnet" });
    } catch (error) {
      db.close();
      throw error;
    }
  }, 60_000);
  afterAll(() => db.close());

  it("is a numbered migration that re-applies cleanly", () => {
    expect(retentionMigration).toBeDefined();
    db.query(readFileSync(join(migrations, retentionMigration!), "utf8"));
    // Re-applying 0063 restores its six tasks; 0072 (re-runnable) adds task 7 back.
    db.query(readFileSync(join(migrations, ALARMS_MIGRATION), "utf8"));
    expect(db.query("select string_agg(task_name, ',' order by task_position) from mancipatio_ops.retention_tasks()"))
      .toBe(TASKS.join(","));
  });

  it("task 7 prunes complete and invalid alarm jobs after 90 days, never pending ones", () => {
    db.query(`truncate public.onchain_event_jobs;
      insert into public.onchain_event_jobs(network, signature, source, status, created_at, updated_at) values
        ('devnet', repeat('2', 88), 'webhook', 'complete', now() - interval '100 days', now() - interval '91 days'),
        ('devnet', repeat('3', 88), 'gap-scan', 'invalid', now() - interval '100 days', now() - interval '91 days'),
        ('devnet', repeat('4', 88), 'webhook', 'pending', now() - interval '200 days', now() - interval '200 days'),
        ('devnet', repeat('6', 88), 'webhook', 'complete', now() - interval '89 days', now() - interval '89 days');`);
    expect(prune()).toMatchObject({ onchain_event_jobs: 2 });
    expect(db.query("select string_agg(left(signature, 1), ',' order by signature) from public.onchain_event_jobs")).toBe("4,6");
    db.query("truncate public.onchain_event_jobs");
  });

  it("prunes exactly the expired operational rows and keeps what users and audits read", () => {
    db.query(SEED);
    const result = prune();
    expect(result).toMatchObject({
      indexer_jobs: 2, indexer_event_payloads: 1, purchase_evidence_jobs: 2, auth_login_tokens: 2, auth_google_states: 1,
      cron_job_run_details: null, skipped: { cron_job_run_details: "absent" }, more: false, interrupted: [],
    });
    expect(snapshot()).toEqual({
      // Pending work is never pruned, however old; recent completions stay.
      indexer_jobs: ["complete-29d", "pending-60d"],
      indexer_events: [
        { signature: "event-89d", payload: { raw: 1 }, ix_name: "sell", decoded: false, wallets: ["Wallet2"], slot: 200, has_block_time: true },
        // History columns intact; only the raw payload is emptied.
        { signature: "event-91d", payload: {}, ix_name: "buy", decoded: true, wallets: ["Wallet1"], slot: 100, has_block_time: true },
        { signature: "event-already-empty", payload: {}, ix_name: "init", decoded: true, wallets: null, slot: 50, has_block_time: false },
        // Kept: the only data a wallets backfill could use.
        { signature: "event-pre-0039", payload: { accountData: [{ account: "Wallet3" }] }, ix_name: "buy", decoded: true, wallets: null, slot: 40, has_block_time: true },
        // Kept: its job is still pending.
        { signature: "event-undecoded-95d", payload: { raw: 2 }, ix_name: "buy", decoded: false, wallets: ["Wallet4"], slot: 60, has_block_time: true },
      ],
      purchase_evidence_jobs: ["purchase-complete-89d", "purchase-pending-120d"],
      // Expired links go, used or not; a used link that has not expired yet stays.
      auth_login_tokens: ["live@x.test", "used-live@x.test"],
      auth_google_states: ["https://live.test/cb"],
    });
    // A second run finds nothing left.
    expect(prune()).toMatchObject({ indexer_jobs: 0, indexer_event_payloads: 0, purchase_evidence_jobs: 0, auth_login_tokens: 0, auth_google_states: 0 });
  });

  it("records counts only for each run", () => {
    db.query(SEED);
    prune();
    const runs = JSON.parse(db.query("select jsonb_agg(result) from mancipatio_ops.retention_runs"));
    expect(runs).toHaveLength(1);
    expect(Object.keys(runs[0]).sort()).toEqual([
      "auth_google_states", "auth_login_tokens", "cron_job_run_details", "duration_ms", "indexer_event_payloads",
      "indexer_jobs", "interrupted", "more", "onchain_event_jobs", "purchase_evidence_jobs", "skipped",
    ]);
    expect(JSON.stringify(runs)).not.toMatch(/@x\.test|Wallet|Buyer|complete-|event-/);
  });

  it("previews the same counts with read-only queries", () => {
    db.query(SEED);
    const before = snapshot();
    const counted = preview();
    expect(counted).toMatchObject({ skipped: { cron_job_run_details: "absent" }, limit: 100000 });
    // Runs inside a read-only transaction: it cannot write or lock rows for update.
    expect(JSON.parse(db.query(`begin read only; select ${PREVIEW}(); rollback;`))).toEqual(counted);
    expect(snapshot()).toEqual(before);
    expect(db.query("select count(*) from mancipatio_ops.retention_runs")).toBe("0");
    // Counts are capped at p_limit per table.
    expect(preview("p_limit => 1")).toMatchObject({ indexer_jobs: 1, purchase_evidence_jobs: 1, auth_login_tokens: 1, limit: 1 });
    expect(taskCounts(counted)).toEqual(taskCounts(prune()));
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

  it("commits every batch: a failure later in the run keeps the work already done", () => {
    db.query(SEED);
    db.query(`create function public.test_refuse_delete() returns trigger language plpgsql as $$ begin raise exception 'refused by test'; end $$;
      create trigger test_refuse_delete before delete on public.purchase_evidence_jobs for each row execute function public.test_refuse_delete();`);
    try {
      expect(() => db.query(`call ${PROC}()`)).toThrow(/refused by test/);
    } finally {
      db.query("drop trigger test_refuse_delete on public.purchase_evidence_jobs; drop function public.test_refuse_delete();");
    }
    const after = snapshot();
    // Tasks before the failure are committed; the failing task and later ones are untouched.
    expect(after.indexer_jobs).toEqual(["complete-29d", "pending-60d"]);
    expect(after.indexer_events.find((e: { signature: string }) => e.signature === "event-91d").payload).toEqual({});
    expect(after.purchase_evidence_jobs).toHaveLength(4);
    expect(after.auth_login_tokens).toHaveLength(4);
    // No run is recorded for a failed run; the next one continues.
    expect(db.query("select count(*) from mancipatio_ops.retention_runs")).toBe("0");
    expect(prune()).toMatchObject({ indexer_jobs: 0, purchase_evidence_jobs: 2, auth_login_tokens: 2 });
  });

  it("refuses to run as one transaction", () => {
    db.query(SEED);
    expect(() => db.query(`begin; call ${PROC}(); commit;`)).toThrow(/invalid transaction termination/);
    expect(snapshot().indexer_jobs).toHaveLength(4);
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

  it("moves on from a table that stays locked and records it as interrupted", async () => {
    db.query(SEED);
    const holder = db.queryAsync(`begin; lock table public.auth_login_tokens in access exclusive mode; select pg_sleep(7); commit;`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const result = prune();
    expect(result).toMatchObject({
      indexer_jobs: 2, purchase_evidence_jobs: 2, auth_login_tokens: 0, auth_google_states: 1,
      interrupted: ["auth_login_tokens"], more: true,
    });
    await holder;
    expect(prune()).toMatchObject({ auth_login_tokens: 2, interrupted: [], more: false });
  }, 20_000);

  it("stops at its time budget and leaves the rest for the next run", async () => {
    db.query(SEED);
    // The first batch waits ~1.6 s for this lock (below lock_timeout), past a 1 s budget.
    const holder = db.queryAsync(`begin; lock table public.indexer_jobs in access exclusive mode; select pg_sleep(2); commit;`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const result = prune("p_budget_seconds => 1");
    await holder;
    expect(result).toMatchObject({ indexer_jobs: 2, indexer_event_payloads: 0, purchase_evidence_jobs: 0, auth_login_tokens: 0, more: true, interrupted: [] });
    expect(prune()).toMatchObject({ indexer_jobs: 0, indexer_event_payloads: 1, purchase_evidence_jobs: 2, auth_login_tokens: 2, more: false });
  }, 20_000);

  it("rejects unsafe parameters", () => {
    for (const args of ["p_batch_size => 0", "p_batch_size => 50001", "p_max_batches => 0", "p_max_batches => 1001",
      "p_budget_seconds => 0", "p_budget_seconds => 3601", "p_batch_size => null"]) {
      expect(() => db.query(`call ${PROC}(${args})`)).toThrow(/Invalid retention parameters/);
    }
    for (const args of ["p_limit => 0", "p_limit => null"]) {
      expect(() => db.query(`select ${PREVIEW}(${args})`)).toThrow(/Invalid retention parameters/);
    }
  });

  it("is a private invoker procedure that pins its own search path", () => {
    expect(db.query(`select prokind::text || '|' || prosecdef || '|' || coalesce(array_to_string(proconfig, ','), '') from pg_proc where oid = '${PROC_SIG}'::regprocedure`))
      .toBe("p|false|");
    expect(db.query(`select prosecdef || '|' || array_to_string(proconfig, ',') from pg_proc where oid = '${PREVIEW}(integer)'::regprocedure`))
      .toBe('false|search_path=""');
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(() => db.query(`set role ${role};call ${PROC}()`)).toThrow(/permission denied/);
      expect(() => db.query(`set role ${role};select ${PREVIEW}()`)).toThrow(/permission denied/);
      expect(() => db.query(`set role ${role};select * from mancipatio_ops.retention_runs`)).toThrow(/permission denied/);
      for (const routine of [PROC_SIG, `${PREVIEW}(integer)`, "mancipatio_ops.retention_tasks()"]) {
        expect(db.query(`select has_function_privilege('${role}', '${routine}', 'EXECUTE')`)).toBe("f");
      }
    }
  });

  it("ignores a caller's search path, so objects in it cannot hijack the run", () => {
    db.query(SEED);
    db.query(`create schema hijack;
      create function hijack.jsonb_build_object(text, bigint) returns jsonb language plpgsql as $$ begin raise exception 'hijacked'; end $$;`);
    try {
      // Code that resolves names through this path would call the impostor.
      expect(() => db.query("set search_path = hijack, public; select jsonb_build_object('a'::text, 1::bigint)")).toThrow(/hijacked/);
      db.query(`set search_path = hijack, public; call ${PROC}()`);
    } finally {
      db.query("drop schema hijack cascade");
    }
    expect(JSON.parse(db.query(LAST_RUN))).toMatchObject({ indexer_jobs: 2 });
  });

  it("builds its indexes concurrently and each batch can use them", () => {
    const migration = readFileSync(join(migrations, retentionMigration!), "utf8");
    const afterCommit = migration.slice(migration.lastIndexOf("\ncommit;"));
    for (const index of ["indexer_jobs_complete_updated_idx", "indexer_events_payload_created_idx",
      "purchase_evidence_jobs_closed_updated_idx", "auth_login_tokens_expires_idx"]) {
      expect(afterCommit).toMatch(new RegExp(`create index concurrently if not exists ${index}`));
      expect(db.query(`select indisvalid from pg_index where indexrelid = 'public.${index}'::regclass`)).toBe("t");
    }
    // decoded stays out of the predicate so finish_indexer_job's update can be HOT.
    expect(db.query("select pg_get_expr(indpred, indrelid) from pg_index where indexrelid = 'public.indexer_events_payload_created_idx'::regclass"))
      .not.toMatch(/decoded/);
    const plan = db.query(`set enable_seqscan = off; explain select id from public.indexer_events
      where payload <> '{}'::jsonb and wallets is not null and decoded and created_at < now() - interval '90 days' order by created_at limit 10`);
    expect(plan).toContain("indexer_events_payload_created_idx");
    const tokens = db.query(`set enable_seqscan = off; explain select token_hash from public.auth_login_tokens where expires_at < now() order by expires_at limit 10`);
    expect(tokens).toContain("auth_login_tokens_expires_idx");
  });

  it("prunes pg_cron history of this project's jobs after 7 days once pg_cron exists", () => {
    db.query(`create schema cron;
      create table cron.job(jobid bigint primary key, jobname text unique, schedule text, command text, active boolean);
      create table cron.job_run_details(runid bigserial primary key, jobid bigint, status text, return_message text,
        start_time timestamptz, end_time timestamptz);
      insert into cron.job values (1, 'mancipatio-retry-devnet', '* * * * *', 'select 1', true),
        (2, 'supabase-managed', '0 * * * *', 'select 1', true);
      insert into cron.job_run_details(jobid, status, return_message, start_time, end_time) values
        (1, 'succeeded', 'old', now() - interval '8 days', now() - interval '8 days' + interval '1 second'),
        (1, 'failed', 'old-unfinished', now() - interval '9 days', null),
        (1, 'succeeded', 'recent', now() - interval '6 days', now() - interval '6 days' + interval '1 second'),
        (1, 'running', 'now', now(), null),
        (2, 'succeeded', 'other-job-old', now() - interval '30 days', now() - interval '30 days' + interval '1 second');`);
    db.query(SEED);
    expect(preview()).toMatchObject({ cron_job_run_details: 2, skipped: {} });
    expect(prune()).toMatchObject({ cron_job_run_details: 2, skipped: {}, indexer_jobs: 2 });
    expect(db.query("select string_agg(return_message, ',' order by runid) from cron.job_run_details")).toBe("recent,now,other-job-old");
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

    it("installs one network-agnostic daily job, disabled, as a bare CALL", () => {
      const sql = script();
      expect(sql.replace(/--.*$/gm, "")).not.toMatch(/devnet|mainnet|testnet|localnet|https?:\/\/|vault|secret/i);
      db.query(sql);
      expect(db.query("select jobname || '|' || schedule || '|' || active from cron.job where jobname = 'mancipatio-retention'"))
        .toBe("mancipatio-retention|17 3 * * *|false");
      const command = db.query("select command from cron.job where jobname = 'mancipatio-retention'");
      // One statement only: a prefix such as "set statement_timeout" would make the run one transaction and fail.
      expect(command).toBe(`call ${PROC}()`);
      db.query(SEED);
      db.query(command);
      expect(JSON.parse(db.query(LAST_RUN))).toMatchObject({ indexer_jobs: 2, more: false });
    });

    it("re-installs disabled after an operator enabled it", () => {
      db.query("update cron.job set active = true where jobname = 'mancipatio-retention'");
      db.query(script());
      expect(db.query("select active from cron.job where jobname = 'mancipatio-retention'")).toBe("f");
      expect(db.query("select count(*) from cron.job where jobname = 'mancipatio-retention'")).toBe("1");
    });

    it("refuses to install while the operation is exposed", () => {
      db.query(`grant usage on schema mancipatio_ops to anon`);
      try {
        expect(() => db.query(script())).toThrow(/exposed/);
      } finally {
        db.query(`revoke usage on schema mancipatio_ops from anon`);
      }
      db.query(`grant execute on procedure ${PROC_SIG} to service_role`);
      try {
        expect(() => db.query(script())).toThrow(/exposed/);
      } finally {
        db.query(`revoke execute on procedure ${PROC_SIG} from service_role`);
      }
    });

    it("reports status with a read-only preview and changes nothing", () => {
      db.query(SEED);
      const runs = db.query("select count(*) from mancipatio_ops.retention_runs");
      const before = snapshot();
      const status = readFileSync("scripts/ops/retention-scheduler-status.sql", "utf8");
      expect(status).toMatch(/^begin read only;$/m);
      expect(status).toMatch(/statement_timeout = '60s'/);
      const output = db.query(status);
      expect(output).toContain("mancipatio-retention");
      expect(output).toContain('"indexer_jobs": 2');
      expect(snapshot()).toEqual(before);
      expect(db.query("select count(*) from mancipatio_ops.retention_runs")).toBe(runs);
    });
  });
});
