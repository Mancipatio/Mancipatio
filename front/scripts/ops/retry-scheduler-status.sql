-- Read-only metadata from the synchronous worker. No request/response contents.
begin read only;
select jobid,jobname,schedule,active
from cron.job where jobname='mancipatio-retry-devnet';
select id,requested_at,completed_at,duration_ms,http_status,ok,outcome,worker_state,
  indexer_complete,indexer_pending,indexer_invalid,
  purchases_complete,purchases_pending,purchases_invalid
from mancipatio_ops.retry_http_runs order by requested_at desc limit 20;
select status,count(*) as runs from cron.job_run_details
where jobid in (select jobid from cron.job where jobname='mancipatio-retry-devnet')
  and start_time>now()-interval '24 hours' group by status;
rollback;
