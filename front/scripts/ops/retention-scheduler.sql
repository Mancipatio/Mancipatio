-- Daily operational retention (migration 0063). Network-agnostic: ONE job per
-- database prunes every network's rows by age; nothing here names a network,
-- a URL or a secret. Installation always DISABLES the job. Review first:
--   psql -f scripts/ops/retention-scheduler-status.sql   (includes a dry run)
-- then enable:
--   select cron.alter_job(jobid, active := true) from cron.job where jobname = 'mancipatio-retention';
-- Re-running this file updates the schedule/command and disables the job again.
begin;

create extension if not exists pg_cron with schema pg_catalog;

do $$
begin
  if to_regprocedure('mancipatio_ops.prune_operational_data(integer,integer,boolean)') is null then
    raise exception 'Apply migration 0063 before installing the retention job';
  end if;
  if has_schema_privilege('anon', 'mancipatio_ops', 'USAGE')
     or has_schema_privilege('authenticated', 'mancipatio_ops', 'USAGE')
     or has_function_privilege('anon', 'mancipatio_ops.prune_operational_data(integer,integer,boolean)', 'EXECUTE')
     or has_function_privilege('authenticated', 'mancipatio_ops.prune_operational_data(integer,integer,boolean)', 'EXECUTE')
     or has_function_privilege('service_role', 'mancipatio_ops.prune_operational_data(integer,integer,boolean)', 'EXECUTE') then
    raise exception 'Retention operation is exposed outside the database owner';
  end if;
end;
$$;

-- 03:17 UTC: off-peak for EU users, away from the top of the hour. The outer
-- deadline bounds one run; a capped run continues the next day (more=true).
select cron.schedule('mancipatio-retention', '17 3 * * *',
  'set statement_timeout=''300s''; select mancipatio_ops.prune_operational_data();');
select cron.alter_job(jobid, active := false)
  from cron.job where jobname = 'mancipatio-retention';
commit;
