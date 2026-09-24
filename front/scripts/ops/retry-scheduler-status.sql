-- Read-only metadata from the synchronous worker. No request/response contents.
--   MANCI_TARGET=<t> bash scripts/db.sh -f scripts/ops/retry-scheduler-status.sql
begin read only;
select jobid,jobname,schedule,active
from cron.job where jobname='mancipatio-retry-'||public.deployment_network();
select network,origin,updated_at,updated_by from mancipatio_ops.retry_worker_config;
select id,requested_at,completed_at,duration_ms,http_status,ok,outcome,worker_state,
  indexer_complete,indexer_pending,indexer_invalid,
  purchases_complete,purchases_pending,purchases_invalid
from mancipatio_ops.retry_http_runs order by requested_at desc limit 20;
select status,count(*) as runs from cron.job_run_details
where jobid in (select jobid from cron.job where jobname='mancipatio-retry-'||public.deployment_network())
  and start_time>now()-interval '24 hours' group by status;
rollback;
