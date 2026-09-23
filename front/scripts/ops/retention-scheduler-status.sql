-- Retention job status (migration 0063, retention-scheduler.sql). Counts only;
-- no row contents. The preview runs plain COUNT queries over the same
-- predicates a run uses: it changes nothing and takes no row locks, and the
-- whole file runs read-only under a 60 s statement timeout.
begin read only;
set local statement_timeout = '60s';
select jobid, jobname, schedule, active
from cron.job where jobname = 'mancipatio-retention';
select id, started_at, finished_at, result
from mancipatio_ops.retention_runs order by started_at desc limit 14;
-- The job prunes this project's pg_cron history after 7 days.
select status, count(*) as runs, max(start_time) as latest
from cron.job_run_details
where jobid in (select jobid from cron.job where jobname = 'mancipatio-retention')
  and start_time > now() - interval '7 days'
group by status;
select mancipatio_ops.retention_preview() as would_prune;
rollback;
