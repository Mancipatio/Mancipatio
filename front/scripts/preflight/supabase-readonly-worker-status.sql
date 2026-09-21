begin read only;
set local statement_timeout='15s';
select jsonb_build_object(
  'checked_at',clock_timestamp(),
  'job',(select jsonb_build_object('jobid',jobid,'name',jobname,'active',active,'schedule',schedule) from cron.job where jobname='mancipatio-retry-devnet'),
  'transport','synchronous_http',
  'invocations',(select coalesce(jsonb_agg(to_jsonb(x) order by requested_at desc),'[]'::jsonb) from (select id,requested_at,completed_at,duration_ms,http_status,ok,outcome,worker_state,indexer_complete,indexer_pending,indexer_invalid,purchases_complete,purchases_pending,purchases_invalid from mancipatio_ops.retry_http_runs order by requested_at desc limit 20) x),
  'legacy_net_endpoint_queue_rows',(select count(*) from net.http_request_queue where url='https://www.manci.io/api/internal/retry?limit=10'),
  'scheduled_runs',(select coalesce(jsonb_object_agg(status,n),'{}'::jsonb) from (select status,count(*) n from cron.job_run_details where jobid in (select jobid from cron.job where jobname='mancipatio-retry-devnet') and start_time>now()-interval '24 hours' group by status) x),
  'indexer_readiness',(select coalesce(jsonb_agg(jsonb_build_object('network',network,'status',status,'completed',completed_at is not null,'checked_at',checked_at)),'[]'::jsonb) from public.indexer_sync_state where network='devnet'),
  'indexer_job_counts',(select coalesce(jsonb_object_agg(status,n),'{}'::jsonb) from (select status,count(*) n from public.indexer_jobs where network='devnet' group by status) x),
  'purchase_job_counts',(select coalesce(jsonb_object_agg(status,n),'{}'::jsonb) from (select status,count(*) n from public.purchase_evidence_jobs where network='devnet' group by status) x)
) preflight;
rollback;
