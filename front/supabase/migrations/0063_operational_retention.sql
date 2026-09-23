-- 0063: operational data retention.
--
-- The procedure mancipatio_ops.prune_operational_data() removes operational
-- rows that have served their purpose. pg_cron runs it daily as the bare
-- command `call mancipatio_ops.prune_operational_data()`, and
-- scripts/ops/retention-scheduler.sql installs that job DISABLED. It works
-- across every network, by age only:
--
--   indexer_jobs            complete jobs, 30 days after completion. There is
--                           no failed state: a failing job stays pending and
--                           keeps retrying. Pending jobs are never pruned.
--   indexer_events          rows are KEPT: portfolio history, the admin audit
--                           feed and health read id, created_at, signature,
--                           ix_name, decoded, wallets and block_time. Only the
--                           raw webhook payload, which nothing reads, is
--                           emptied to '{}' after 90 days, and only once the
--                           event is decoded and has wallets. Rows written
--                           before 0039 (wallets null) keep the payload a
--                           wallets backfill would need, and an undecoded
--                           event keeps it for debugging its pending job.
--   purchase_evidence_jobs  complete/invalid jobs, 90 days after their last
--                           update. The verified purchase itself lives in
--                           commitments. Pending jobs are never pruned.
--   auth_login_tokens       sign-in links once expired, used or not (0058
--                           caps a link's life at 30 minutes, and a link can
--                           only be used before it expires).
--   auth_google_states      expired Google sign-in states.
--   cron.job_run_details    run history of this project's jobs (mancipatio-*)
--                           after 7 days, where pg_cron is installed and this
--                           role may delete it. Other jobs' history is left
--                           alone, and so are rows of jobs no longer scheduled.
--
-- Transactions: every batch (at most p_batch_size rows of one table) is its
-- own transaction and commits before the next begins. Row locks are held for
-- one batch only, a failure keeps the batches already committed, and no
-- long transaction holds back vacuum. Candidates are picked FOR UPDATE SKIP
-- LOCKED, so rows a worker holds are skipped rather than waited for; a
-- webhook insert that conflicts on (network, signature) with a row the
-- current batch is deleting waits for that one batch. Every batch runs with
-- lock_timeout 5s: a table that stays locked is recorded as "interrupted"
-- and the run moves on. A run stops at p_max_batches per table or once
-- p_budget_seconds have passed, reports more=true, and the next run
-- continues. Each run records counts only in mancipatio_ops.retention_runs
-- (kept 90 days).
--
-- The procedure is SECURITY INVOKER with no SET options, because PostgreSQL
-- forbids COMMIT in a SECURITY DEFINER procedure or one with a SET clause.
-- Only its owner (the database owner role pg_cron runs as) may execute it,
-- and it pins search_path to '' itself at the start of every transaction.
-- The COMMITs also need CALL to be the whole top-level statement: inside an
-- explicit transaction or a multi-statement command it fails immediately.
--
-- mancipatio_ops.retention_preview() counts what a run would prune with
-- plain COUNT queries over the same predicates (retention_tasks()). It
-- changes nothing and takes no row locks.
--
-- The indexes are built CONCURRENTLY after the transaction, so webhook,
-- purchase and sign-in writes keep flowing while they build. Apply this file
-- with psql -f (scripts/db.sh -f), never inside an outer transaction.
begin;

create schema if not exists mancipatio_ops;
revoke all on schema mancipatio_ops from public, anon, authenticated, service_role;

create table if not exists mancipatio_ops.retention_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  result jsonb not null check (jsonb_typeof(result) = 'object')
);
alter table mancipatio_ops.retention_runs enable row level security;
revoke all on mancipatio_ops.retention_runs from public, anon, authenticated, service_role;
revoke all on sequence mancipatio_ops.retention_runs_id_seq from public, anon, authenticated, service_role;
create index if not exists retention_runs_started_at_idx on mancipatio_ops.retention_runs(started_at);

-- The one definition of every task, read by the procedure and the preview.
-- Constant SQL only; now() is the start of each batch's transaction.
--   lock_rows  pick candidates FOR UPDATE SKIP LOCKED (not on pg_cron's own
--              table: a row lock there needs UPDATE on a table pg_cron owns,
--              and pg_cron only writes rows of runs still in progress)
--   optional   skip when the table is missing or this role may not touch it
create or replace function mancipatio_ops.retention_tasks()
returns table(
  task_position integer, task_name text, relation text, key_column text,
  candidates text, order_column text, change text, lock_rows boolean, optional boolean
)
language sql immutable set search_path = ''
as $$
  values
    (1, 'indexer_jobs', 'public.indexer_jobs', 'id',
      $p$status = 'complete' and updated_at < now() - interval '30 days'$p$,
      'updated_at', 'delete', true, false),
    (2, 'indexer_event_payloads', 'public.indexer_events', 'id',
      $p$payload <> '{}'::jsonb and wallets is not null and decoded and created_at < now() - interval '90 days'$p$,
      'created_at', $p$set payload = '{}'::jsonb$p$, true, false),
    (3, 'purchase_evidence_jobs', 'public.purchase_evidence_jobs', 'id',
      $p$status in ('complete', 'invalid') and updated_at < now() - interval '90 days'$p$,
      'updated_at', 'delete', true, false),
    (4, 'auth_login_tokens', 'public.auth_login_tokens', 'token_hash',
      $p$expires_at < now()$p$,
      'expires_at', 'delete', true, false),
    (5, 'auth_google_states', 'public.auth_google_states', 'state_hash',
      $p$expires_at < now()$p$,
      'expires_at', 'delete', true, false),
    (6, 'cron_job_run_details', 'cron.job_run_details', 'runid',
      $p$jobid in (select j.jobid from cron.job j where j.jobname like 'mancipatio-%') and coalesce(end_time, start_time) < now() - interval '7 days'$p$,
      'runid', 'delete', false, true)
$$;

create or replace procedure mancipatio_ops.prune_operational_data(
  p_batch_size integer default 5000,
  p_max_batches integer default 20,
  p_budget_seconds integer default 240
)
language plpgsql
as $$
declare
  started timestamptz := pg_catalog.clock_timestamp();
  deadline timestamptz;
  task_names text[];
  task_relations text[];
  task_statements text[];
  task_optional boolean[];
  affected bigint;
  total bigint;
  batches integer;
  more boolean := false;
  interrupted text[] := '{}';
  skipped jsonb := '{}';
  counts jsonb := '{}';
begin
  -- No SET clause is possible with COMMIT: pin the settings per transaction.
  perform pg_catalog.set_config('search_path', '', true);
  perform pg_catalog.set_config('lock_timeout', '5s', true);
  if p_batch_size is null or p_batch_size not between 1 and 50000
    or p_max_batches is null or p_max_batches not between 1 and 1000
    or p_budget_seconds is null or p_budget_seconds not between 1 and 3600 then
    raise exception 'Invalid retention parameters' using errcode = '22023';
  end if;
  deadline := started + make_interval(secs => p_budget_seconds);

  select array_agg(t.task_name order by t.task_position),
         array_agg(t.relation order by t.task_position),
         array_agg(
           case when t.change = 'delete' then 'delete from ' || t.relation else 'update ' || t.relation || ' ' || t.change end
           || format(' where %I in (select %I from %s where %s order by %I limit $1%s)',
                t.key_column, t.key_column, t.relation, t.candidates, t.order_column,
                case when t.lock_rows then ' for update skip locked' else '' end)
           order by t.task_position),
         array_agg(t.optional order by t.task_position)
    into task_names, task_relations, task_statements, task_optional
    from mancipatio_ops.retention_tasks() t;

  for i in 1 .. array_length(task_names, 1) loop
    total := 0;
    batches := 0;
    if task_optional[i] and to_regclass(task_relations[i]) is null then
      skipped := skipped || jsonb_build_object(task_names[i], 'absent');
      total := null;
    else
      loop
        if clock_timestamp() >= deadline then
          more := true;
          exit;
        end if;
        begin
          execute task_statements[i] using p_batch_size;
          get diagnostics affected = row_count;
        exception
          when lock_not_available then
            interrupted := interrupted || task_names[i];
            more := true;
            affected := -1;
          when insufficient_privilege then
            if not task_optional[i] then raise; end if;
            skipped := skipped || jsonb_build_object(task_names[i], 'forbidden');
            total := null;
            affected := -1;
        end;
        commit;
        perform pg_catalog.set_config('search_path', '', true);
        perform pg_catalog.set_config('lock_timeout', '5s', true);
        exit when affected < 0;
        total := total + affected;
        batches := batches + 1;
        exit when affected < p_batch_size;
        if batches >= p_max_batches then
          more := true;
          exit;
        end if;
      end loop;
    end if;
    counts := counts || jsonb_build_object(task_names[i], total);
  end loop;

  counts := counts || jsonb_build_object('more', more, 'interrupted', to_jsonb(interrupted), 'skipped', skipped,
    'duration_ms', greatest(0, (extract(epoch from clock_timestamp() - started) * 1000)::integer));
  insert into mancipatio_ops.retention_runs(started_at, finished_at, result)
    values (started, clock_timestamp(), counts);
  delete from mancipatio_ops.retention_runs where started_at < now() - interval '90 days';
end;
$$;

-- Read-only: what the next run would prune, at most p_limit rows per table
-- (the default equals one default run's cap of 20 batches of 5000).
create or replace function mancipatio_ops.retention_preview(p_limit integer default 100000)
returns jsonb
language plpgsql stable set search_path = ''
as $$
declare
  task record;
  n bigint;
  skipped jsonb := '{}';
  counts jsonb := '{}';
begin
  if p_limit is null or p_limit not between 1 and 10000000 then
    raise exception 'Invalid retention parameters' using errcode = '22023';
  end if;
  for task in select * from mancipatio_ops.retention_tasks() order by task_position loop
    n := null;
    if task.optional and to_regclass(task.relation) is null then
      skipped := skipped || jsonb_build_object(task.task_name, 'absent');
    else
      begin
        execute format('select count(*) from (select 1 from %s where %s limit $1) candidates', task.relation, task.candidates)
          into n using p_limit;
      exception when insufficient_privilege then
        if not task.optional then raise; end if;
        skipped := skipped || jsonb_build_object(task.task_name, 'forbidden');
      end;
    end if;
    counts := counts || jsonb_build_object(task.task_name, n);
  end loop;
  return counts || jsonb_build_object('skipped', skipped, 'limit', p_limit);
end;
$$;

revoke all on function mancipatio_ops.retention_tasks() from public, anon, authenticated, service_role;
revoke all on function mancipatio_ops.retention_preview(integer) from public, anon, authenticated, service_role;
revoke all on procedure mancipatio_ops.prune_operational_data(integer, integer, integer)
  from public, anon, authenticated, service_role;

do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
    if has_schema_privilege(role_name, 'mancipatio_ops', 'USAGE')
       or has_function_privilege(role_name, 'mancipatio_ops.prune_operational_data(integer,integer,integer)', 'EXECUTE')
       or has_function_privilege(role_name, 'mancipatio_ops.retention_preview(integer)', 'EXECUTE')
       or has_function_privilege(role_name, 'mancipatio_ops.retention_tasks()', 'EXECUTE')
       or has_table_privilege(role_name, 'mancipatio_ops.retention_runs', 'SELECT') then
      raise exception 'Retention operation is exposed to %', role_name;
    end if;
  end loop;
end;
$$;

commit;

-- Built CONCURRENTLY, outside the transaction above. Each predicate is
-- implied by its task's candidates, so a batch finds its rows without
-- walking live ones. On indexer_events, `decoded` is deliberately NOT in the
-- predicate: finish_indexer_job() sets it on every event, and a column in an
-- index predicate would stop that update from being HOT. The few undecoded
-- rows are filtered out by the task itself.
create index concurrently if not exists indexer_jobs_complete_updated_idx
  on public.indexer_jobs(updated_at) where status = 'complete';
create index concurrently if not exists indexer_events_payload_created_idx
  on public.indexer_events(created_at) where payload <> '{}'::jsonb and wallets is not null;
create index concurrently if not exists purchase_evidence_jobs_closed_updated_idx
  on public.purchase_evidence_jobs(updated_at) where status in ('complete', 'invalid');
create index concurrently if not exists auth_login_tokens_expires_idx
  on public.auth_login_tokens(expires_at);

-- A failed concurrent build leaves an INVALID index that "if not exists"
-- would skip on the next attempt. Stop instead: drop it with
-- `drop index concurrently public.<name>` and apply this file again.
do $$
declare
  broken text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into broken
  from pg_catalog.pg_index i
  join pg_catalog.pg_class c on c.oid = i.indexrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not i.indisvalid and c.relname in (
    'indexer_jobs_complete_updated_idx', 'indexer_events_payload_created_idx',
    'purchase_evidence_jobs_closed_updated_idx', 'auth_login_tokens_expires_idx');
  if broken is not null then
    raise exception 'Invalid retention index: %. Drop it concurrently and apply 0063 again.', broken;
  end if;
end;
$$;
