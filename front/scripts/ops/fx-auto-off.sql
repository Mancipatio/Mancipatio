-- Off switch of the automatic EUR rate (migration 0080), runbook §15
-- "Automatic EUR rate". Through db.sh (which asserts the target first):
--   MANCI_TARGET=devnet bash scripts/db.sh -f scripts/ops/fx-auto-off.sql
--   MANCI_TARGET=mainnet MANCI_ALLOW_MAINNET=1 bash scripts/db.sh -f scripts/ops/fx-auto-off.sql
--
-- BEFORE running it: the manual USDC row on /admin/limits must be fresh
-- (kind rate, max age at most 7 days on mainnet; fx-scheduler-status.sql
-- shows it with `fresh`). Refresh it there first if it is not: from step 3
-- on it is the rate that counts, and a stale one makes approvals refuse with
-- FX_RATE_STALE. The last result set shows it again.
--
-- About 45 seconds, in this order:
--   1. transaction 1 disables 'mancipatio-fx-<network>' and commits: no new
--      run starts;
--   2. waits fx_off_wait_seconds (default 40) for a run already in flight:
--      the job runs under statement_timeout 30 s (its HTTP call gives up at
--      25 s, fx-scheduler.sql) and the worker route has maxDuration 30 s;
--      that run records through PostgREST, so without the wait it could
--      upsert fx_auto_rates after the delete;
--   3. transaction 2 deletes the network's fx_auto_rates rows: the manual
--      fx_rates rows count again at once (fx_effective_rate,
--      lib/fx-effective.ts);
--   4. after a 5-second settle, re-checks that the job is still disabled and
--      that no automatic row reappeared. Otherwise it stops with an ERROR:
--      it is NOT off; run this file again.
-- Either half alone is not off: a disabled job leaves a fresh automatic rate
-- counting for up to 15 minutes, and deleted rows come back with the next
-- run of a job still enabled. Re-runnable: each run disables, waits, deletes
-- and checks again. -v fx_off_wait_seconds=<n> shortens the wait for the
-- tests only (tests/fx-scheduler.postgres.test.ts); a shorter wait reopens
-- the race in step 2.
--
-- The observations stay (the audit trail, kept 30 days). The alarm worker:
-- right after the delete there is no automatic row while the job ran in the
-- last 5 minutes, so fx-auto-stale FAILS for a few minutes (medium on
-- mainnet, high only if the mint is in use and no fresh manual row covers
-- it, low elsewhere); once the last run is 5 minutes old the job counts as
-- off, the fx-* checks pass, and an incident clears after 3 passes and 5
-- minutes without a failure: about 10 minutes in all.
-- Back on: if scripts/ops/fx-manual-only.sql ran, re-apply
-- supabase/migrations/0080_fx_auto_rates.sql first (fx-scheduler.sql refuses
-- the manual-only resolver); then fx-scheduler.sql (install), select
-- mancipatio_ops.invoke_fx_refresh(), fx-scheduler-status.sql, and
-- cron.alter_job(..., active := true) (runbook §15 "Install, prove, enable").

\if :{?fx_off_wait_seconds}
\else
\set fx_off_wait_seconds 40
\endif

-- 1. No new run.
begin;
do $$
declare job record;
begin
  if to_regclass('public.fx_auto_rates') is null then
    raise exception 'Migration 0080 is not applied: there is no automatic rate to switch off';
  end if;
  if to_regclass('cron.job') is not null then
    for job in execute 'select jobid from cron.job where jobname = $1'
        using 'mancipatio-fx-' || public.deployment_network() loop
      perform cron.alter_job(job.jobid, active := false);
    end loop;
  end if;
end;
$$;
commit;

-- 2. A run already in flight finishes (or is cut off) meanwhile.
\echo 'fx job disabled; waiting for a run already in flight, then deleting the automatic rows'
\o /dev/null
-- The wait is one statement: a role default timeout must not cut it short.
set statement_timeout = '330s';
select pg_catalog.pg_sleep(greatest(0, least(300, :'fx_off_wait_seconds'::numeric)));
\o

-- 3. The manual rows count again.
begin;
delete from public.fx_auto_rates where network = public.deployment_network();
commit;

-- 4. Nothing came back.
\o /dev/null
select pg_catalog.pg_sleep(greatest(0, least(5, :'fx_off_wait_seconds'::numeric)));
\o
do $$
declare
  job_name text := 'mancipatio-fx-' || public.deployment_network();
  enabled boolean := false;
begin
  if to_regclass('cron.job') is not null then
    execute 'select exists (select 1 from cron.job where jobname = $1 and active)' into enabled using job_name;
  end if;
  if enabled then
    raise exception 'NOT off: % was enabled again while the off switch ran. Run scripts/ops/fx-auto-off.sql again', job_name;
  end if;
  if exists (select 1 from public.fx_auto_rates where network = public.deployment_network()) then
    raise exception 'NOT off: an automatic rate reappeared after the delete (a run still in flight, or a manual invoke_fx_refresh()). Run scripts/ops/fx-auto-off.sql again';
  end if;
end;
$$;

select coalesce((select jobname || ' active=' || active from cron.job
                  where jobname = 'mancipatio-fx-' || public.deployment_network()), 'no fx job installed') as fx_job,
       (select count(*) from public.fx_auto_rates where network = public.deployment_network()) as automatic_rows_left;
select r.payment_mint, r.kind, r.eur_per_token, r.as_of, r.max_age, r.override_auto,
       r.kind = 'eur_peg' or r.as_of >= now() - r.max_age as fresh
  from public.fx_rates r where r.network = public.deployment_network() order by r.payment_mint;
