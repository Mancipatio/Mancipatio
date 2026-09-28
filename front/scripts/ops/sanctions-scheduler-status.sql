-- Read-only status of the sanctions list refresh (8.5). Counts, dates and codes only.
--   MANCI_TARGET=<t> bash scripts/db.sh -f scripts/ops/sanctions-scheduler-status.sql
begin read only;
select jobid,jobname,username,schedule,active,
  command='set statement_timeout=''65s''; select mancipatio_ops.invoke_sanctions_refresh();' as command_ok
from cron.job where jobname='mancipatio-sanctions-'||public.deployment_network();
select id,requested_at,duration_ms,http_status,ok,outcome,refresh_state,addresses,error_code
from mancipatio_ops.sanctions_http_runs order by requested_at desc limit 20;
select source,published_on,record_count,address_count,refreshed_at,now()-refreshed_at as age,
  last_attempt_at,last_status,last_error
from public.sanctions_list_state order by source;
select source,count(*) as addresses,max(last_seen_at) as last_seen
from public.sanctions_addresses group by source order by source;
select status,count(*) as alerts,max(created_at) as newest
from public.compliance_alerts where network=public.deployment_network() and evidence->>'screening'='wallet-address'
group by status order by status;
select status,count(*) as runs from cron.job_run_details
where jobid in (select jobid from cron.job where jobname='mancipatio-sanctions-'||public.deployment_network())
  and start_time>now()-interval '7 days' group by status;
rollback;
