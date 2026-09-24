-- Read-only status of the alarm worker (Talas 4.4b). Counts and states only.
--   MANCI_TARGET=<t> bash scripts/db.sh -f scripts/ops/alarm-scheduler-status.sql
begin read only;
select jobid,jobname,username,schedule,active,
  command='set statement_timeout=''60s''; select mancipatio_ops.invoke_alarm_worker();' as command_ok
from cron.job where jobname='mancipatio-alarms-'||public.deployment_network();
select id,requested_at,duration_ms,http_status,ok,outcome,worker_state,
  events_complete,events_pending,events_invalid,checks_reported,checks_failing,notify_state
from mancipatio_ops.alarm_http_runs order by requested_at desc limit 20;
select worker,last_started_at,last_finished_at,last_ok_at,last_status,last_gap_scan_at
from public.worker_heartbeats where network=public.deployment_network() order by worker;
select status,count(*) as jobs,min(created_at) as oldest
from public.onchain_event_jobs where network=public.deployment_network() group by status order by status;
select status,count(*) as jobs,min(created_at) as oldest
from public.spv_issuance_jobs where network=public.deployment_network() group by status order by status;
select notify_state,severity,count(*) as alerts
from public.compliance_alerts where network=public.deployment_network() and notify_state is not null
group by notify_state,severity order by notify_state,severity;
select check_key,pass_streak,last_fail_at,cleared_at
from public.alarm_incidents where network=public.deployment_network() order by coalesce(last_fail_at,updated_at) desc limit 30;
select code,count(*) as holds,min(created_at) as oldest
from public.sale_capacity_holds where network=public.deployment_network() group by code;
select status,count(*) as runs from cron.job_run_details
where jobid in (select jobid from cron.job where jobname='mancipatio-alarms-'||public.deployment_network())
  and start_time>now()-interval '24 hours' group by status;
rollback;
