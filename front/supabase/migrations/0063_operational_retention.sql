-- 0063: operational data retention.
--
-- mancipatio_ops.prune_operational_data() removes operational rows that have
-- served their purpose. It lives in the private ops schema (not exposed to the
-- Data API, no browser or service-role access) and is run daily by pg_cron —
-- scripts/ops/retention-scheduler.sql installs that job DISABLED. It works
-- across every network, by age only:
--
--   indexer_jobs            complete jobs, 30 days after completion. There is
--                           no failed state: a failing job stays pending and
--                           keeps retrying, and /api/health reports its age.
--                           Pending jobs are never pruned.
--   indexer_events          rows are KEPT: portfolio history, the admin audit
--                           feed and health read id, created_at, signature,
--                           ix_name, decoded, wallets and block_time, and
--                           finish_indexer_job() marks them decoded. Only the
--                           raw webhook payload, which nothing reads, is
--                           emptied to '{}' after 90 days.
--   purchase_evidence_jobs  complete/invalid jobs, 90 days after their last
--                           update. The verified purchase itself lives in
--                           commitments. Pending jobs are never pruned.
--   auth_login_tokens       expired sign-in links, and used ones after a day.
--   auth_google_states      expired Google sign-in states.
--   cron.job_run_details    pg_cron history after 7 days, only where pg_cron
--                           is installed and this owner may delete it.
--
-- Work is done in bounded batches (FOR UPDATE SKIP LOCKED: a running worker is
-- never blocked or its leased rows touched). A run that reaches its cap
-- reports more=true and the next run continues. p_dry_run counts the same
-- rows and rolls everything back. Each real run records counts only in
-- mancipatio_ops.retention_runs (kept 90 days).
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

-- Each batch finds its candidates without scanning live rows. The predicates
-- match the statements below exactly, so the planner can use them.
create index if not exists indexer_jobs_complete_updated_idx
  on public.indexer_jobs(updated_at) where status = 'complete';
create index if not exists indexer_events_payload_created_idx
  on public.indexer_events(created_at) where payload <> '{}'::jsonb;
create index if not exists purchase_evidence_jobs_closed_updated_idx
  on public.purchase_evidence_jobs(updated_at) where status in ('complete', 'invalid');
create index if not exists auth_login_tokens_expires_idx
  on public.auth_login_tokens(expires_at);

create or replace function mancipatio_ops.prune_operational_data(
  p_batch_size integer default 5000,
  p_max_batches integer default 20,
  p_dry_run boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s'
as $$
declare
  started timestamptz := clock_timestamp();
  task record;
  affected integer;
  total bigint;
  batches integer;
  more boolean := false;
  counts jsonb := '{}'::jsonb;
  cron_state text := 'absent';
  cron_total bigint;
begin
  if p_batch_size is null or p_batch_size not between 1 and 50000
    or p_max_batches is null or p_max_batches not between 1 and 1000 or p_dry_run is null then
    raise exception 'Invalid retention parameters' using errcode = '22023';
  end if;

  begin
    -- Constant statements only: $1 = batch size, $2 = cutoff.
    for task in
      select * from (values
        (1, 'indexer_jobs', now() - interval '30 days', $q$
          delete from public.indexer_jobs where id in (
            select id from public.indexer_jobs
            where status = 'complete' and updated_at < $2
            order by updated_at limit $1 for update skip locked)$q$),
        (2, 'indexer_event_payloads', now() - interval '90 days', $q$
          update public.indexer_events set payload = '{}'::jsonb where id in (
            select id from public.indexer_events
            where payload <> '{}'::jsonb and created_at < $2
            order by created_at limit $1 for update skip locked)$q$),
        (3, 'purchase_evidence_jobs', now() - interval '90 days', $q$
          delete from public.purchase_evidence_jobs where id in (
            select id from public.purchase_evidence_jobs
            where status in ('complete', 'invalid') and updated_at < $2
            order by updated_at limit $1 for update skip locked)$q$),
        (4, 'auth_login_tokens', now() - interval '1 day', $q$
          delete from public.auth_login_tokens where token_hash in (
            select token_hash from public.auth_login_tokens
            where expires_at < now() or consumed_at < $2
            limit $1 for update skip locked)$q$),
        (5, 'auth_google_states', now(), $q$
          delete from public.auth_google_states where state_hash in (
            select state_hash from public.auth_google_states
            where expires_at < $2
            limit $1 for update skip locked)$q$)
      ) as t(position, name, cutoff, statement)
      order by position
    loop
      total := 0;
      batches := 0;
      loop
        execute task.statement using p_batch_size, task.cutoff;
        get diagnostics affected = row_count;
        total := total + affected;
        batches := batches + 1;
        exit when affected < p_batch_size;
        if batches >= p_max_batches then
          more := true;
          exit;
        end if;
      end loop;
      counts := counts || jsonb_build_object(task.name, total);
    end loop;

    -- pg_cron keeps every run forever. Only where it is installed and this
    -- owner may delete from it; a refusal must not undo the pruning above.
    begin
      if to_regclass('cron.job_run_details') is not null then
        cron_total := 0;
        batches := 0;
        loop
          -- No row locks here: pg_cron only writes rows of runs in progress,
          -- and a row lock would need UPDATE on a table pg_cron owns.
          execute $q$
            delete from cron.job_run_details where runid in (
              select runid from cron.job_run_details
              where coalesce(end_time, start_time) < $2
              order by runid limit $1)$q$
            using p_batch_size, now() - interval '7 days';
          get diagnostics affected = row_count;
          cron_total := cron_total + affected;
          batches := batches + 1;
          exit when affected < p_batch_size;
          if batches >= p_max_batches then
            more := true;
            exit;
          end if;
        end loop;
        cron_state := 'pruned';
      end if;
    exception when insufficient_privilege then
      cron_state := 'forbidden';
      cron_total := null;
    end;
    counts := counts || jsonb_build_object('cron_job_run_details', cron_total, 'cron', cron_state, 'more', more);

    if p_dry_run then
      -- Roll back everything above; the counts survive in local variables.
      raise exception using errcode = 'P0001', message = 'mancipatio_retention_dry_run';
    end if;
  exception when raise_exception then
    if sqlerrm is distinct from 'mancipatio_retention_dry_run' then raise; end if;
  end;

  counts := counts || jsonb_build_object('dry_run', p_dry_run,
    'duration_ms', greatest(0, (extract(epoch from clock_timestamp() - started) * 1000)::integer));
  if not p_dry_run then
    insert into mancipatio_ops.retention_runs(started_at, finished_at, result)
      values (started, clock_timestamp(), counts);
    delete from mancipatio_ops.retention_runs where started_at < now() - interval '90 days';
  end if;
  return counts;
end;
$$;

revoke all on function mancipatio_ops.prune_operational_data(integer, integer, boolean)
  from public, anon, authenticated, service_role;

do $$
begin
  if has_schema_privilege('anon', 'mancipatio_ops', 'USAGE')
     or has_schema_privilege('authenticated', 'mancipatio_ops', 'USAGE')
     or has_function_privilege('anon', 'mancipatio_ops.prune_operational_data(integer,integer,boolean)', 'EXECUTE')
     or has_function_privilege('authenticated', 'mancipatio_ops.prune_operational_data(integer,integer,boolean)', 'EXECUTE')
     or has_table_privilege('anon', 'mancipatio_ops.retention_runs', 'SELECT')
     or has_table_privilege('authenticated', 'mancipatio_ops.retention_runs', 'SELECT') then
    raise exception 'Retention operation is exposed to browser roles';
  end if;
end;
$$;

commit;
