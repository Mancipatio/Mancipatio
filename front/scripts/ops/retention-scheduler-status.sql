-- Retention job status (migration 0063, retention-scheduler.sql). Counts only;
-- no row contents. The dry run counts what the next run would prune and rolls
-- it back; the whole file ends in ROLLBACK, so nothing here changes data.
begin;
select jobid, jobname, schedule, active
from cron.job where jobname = 'mancipatio-retention';
select id, started_at, finished_at, result
from mancipatio_ops.retention_runs order by started_at desc limit 14;
select status, count(*) as runs, max(start_time) as latest
from cron.job_run_details
where jobid in (select jobid from cron.job where jobname = 'mancipatio-retention')
  and start_time > now() - interval '30 days'
group by status;
select mancipatio_ops.prune_operational_data(p_dry_run => true) as would_prune;
rollback;
