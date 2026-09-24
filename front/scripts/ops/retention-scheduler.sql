-- Daily operational retention (migration 0063). Network-agnostic: ONE job per
-- database prunes every network's rows by age; nothing here names a network,
-- a URL or a secret, so the SQL is identical for every project. Install it
-- through db.sh, which asserts the target first:
--   MANCI_TARGET=<t> bash scripts/db.sh -f scripts/ops/retention-scheduler.sql
-- Installation always DISABLES the job. Review first:
--   MANCI_TARGET=<t> bash scripts/db.sh -f scripts/ops/retention-scheduler-status.sql   (read-only preview)
-- then enable:
--   select cron.alter_job(jobid, active := true) from cron.job where jobname = 'mancipatio-retention';
-- Re-running this file updates the schedule/command and disables the job again.
--
-- The command is a bare CALL on purpose: the procedure commits after every
-- batch, which PostgreSQL allows only when the CALL is the whole top-level
-- statement. A `set statement_timeout ...;` prefix would turn it into one
-- multi-statement transaction and every run would fail. The procedure bounds
-- itself instead: a 240 s time budget, a per-table batch cap, and a 5 s
-- lock_timeout on every batch.
begin;

create extension if not exists pg_cron with schema pg_catalog;

do $$
declare
  role_name text;
begin
  if to_regprocedure('mancipatio_ops.prune_operational_data(integer,integer,integer)') is null
     or to_regprocedure('mancipatio_ops.retention_preview(integer)') is null then
    raise exception 'Apply migration 0063 before installing the retention job';
  end if;
  foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
    if has_schema_privilege(role_name, 'mancipatio_ops', 'USAGE')
       or has_function_privilege(role_name, 'mancipatio_ops.prune_operational_data(integer,integer,integer)', 'EXECUTE')
       or has_function_privilege(role_name, 'mancipatio_ops.retention_preview(integer)', 'EXECUTE') then
      raise exception 'Retention operation is exposed outside the database owner';
    end if;
  end loop;
end;
$$;

-- 03:17 UTC: off-peak for EU users, away from the top of the hour. A run that
-- hits its budget or cap reports more=true and the next day continues.
select cron.schedule('mancipatio-retention', '17 3 * * *',
  'call mancipatio_ops.prune_operational_data()');
select cron.alter_job(jobid, active := false)
  from cron.job where jobname = 'mancipatio-retention';
commit;
