begin read only;
set local statement_timeout='15s';
select jsonb_build_object(
  'checked_at',clock_timestamp(),
  'network',public.deployment_network(),
  'job',(select jsonb_build_object('jobid',jobid,'name',jobname,'active',active,'schedule',schedule) from cron.job where jobname='mancipatio-retry-'||public.deployment_network()),
  'config',(select jsonb_build_object('network',network,'origin',origin,'updated_at',updated_at) from mancipatio_ops.retry_worker_config),
  'transport','synchronous_http',
  'invocations',(select coalesce(jsonb_agg(to_jsonb(x) order by requested_at desc),'[]'::jsonb) from (select id,requested_at,completed_at,duration_ms,http_status,ok,outcome,worker_state,indexer_complete,indexer_pending,indexer_invalid,purchases_complete,purchases_pending,purchases_invalid from mancipatio_ops.retry_http_runs order by requested_at desc limit 20) x),
  'scheduled_runs',(select coalesce(jsonb_object_agg(status,n),'{}'::jsonb) from (select status,count(*) n from cron.job_run_details where jobid in (select jobid from cron.job where jobname='mancipatio-retry-'||public.deployment_network()) and start_time>now()-interval '24 hours' group by status) x),
  'indexer_readiness',(select coalesce(jsonb_agg(jsonb_build_object('network',network,'status',status,'completed',completed_at is not null,'checked_at',checked_at)),'[]'::jsonb) from public.indexer_sync_state where network=public.deployment_network()),
  'indexer_job_counts',(select coalesce(jsonb_object_agg(status,n),'{}'::jsonb) from (select status,count(*) n from public.indexer_jobs where network=public.deployment_network() group by status) x),
  'purchase_job_counts',(select coalesce(jsonb_object_agg(status,n),'{}'::jsonb) from (select status,count(*) n from public.purchase_evidence_jobs where network=public.deployment_network() group by status) x)
) preflight;
rollback;
