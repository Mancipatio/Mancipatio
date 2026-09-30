-- Read-only: one transaction's way through the indexer and the alarms, for
-- the 6.4 drill (runbook §16 "6.4 drill"):
--   MANCI_TARGET=<t> bash scripts/db.sh -Atq -v sig=<signature> -f scripts/ops/indexer-drill-status.sql
-- (-Atq: one `|`-separated line per row, no headers or command tags: the
-- form the runbook quotes and tests/indexer-resilience.postgres.test.ts
-- checks).
-- After any number of deliveries of the same transaction, `events`, `jobs`
-- and `alarm_jobs` are 1 each; `delivery` (and the alarm job's `source`)
-- tells a webhook delivery from a gap-scan repair. No payload, wallet list
-- or RPC text is printed.
\if :{?sig}
\else
  \echo 'Usage: MANCI_TARGET=<t> bash scripts/db.sh -Atq -v sig=<transaction signature> -f scripts/ops/indexer-drill-status.sql'
  \quit
\endif
begin read only;
select
  (select count(*) from public.indexer_events where network = public.deployment_network() and signature = :'sig') as events,
  (select count(*) from public.indexer_jobs where network = public.deployment_network() and signature = :'sig') as jobs,
  (select count(*) from public.onchain_event_jobs where network = public.deployment_network() and signature = :'sig') as alarm_jobs,
  (select count(*) from public.compliance_alerts where network = public.deployment_network() and tx_signature = :'sig') as alerts;
-- `delivery` as the 0072 trigger tells them apart (Helius's own `source` field names a program family).
select 'event' as row, ix_name,
  case when ix_name = 'GAP_SCAN' and payload->>'source' = 'gap-scan' then 'gap-scan' else 'webhook' end as delivery,
  slot, decoded, created_at
from public.indexer_events where network = public.deployment_network() and signature = :'sig';
select 'indexer_job' as row, status, attempts, last_error is not null as has_error, created_at, updated_at
from public.indexer_jobs where network = public.deployment_network() and signature = :'sig';
select 'alarm_job' as row, source, status, attempts, last_error, alerts, created_at, updated_at
from public.onchain_event_jobs where network = public.deployment_network() and signature = :'sig';
select 'sync' as row, status, last_slot, completed_at, checked_at,
  round(extract(epoch from now() - checked_at)) as checked_age_seconds
from public.indexer_sync_state where network = public.deployment_network();
select 'heartbeat' as row, mode, last_outcome, last_reason, last_attempt_at, last_proven_at, last_expired_at
from public.indexer_heartbeat_state where network = public.deployment_network();
select 'gap_scan' as row, last_gap_scan_at, last_ok_at, last_status
from public.worker_heartbeats where network = public.deployment_network() and worker = 'alarms';
select 'incident' as row, check_key, last_fail_at, cleared_at, pass_streak
from public.alarm_incidents
where network = public.deployment_network()
  and check_key in ('indexer-gap', 'gap-scan-incomplete', 'gap-scan-overdue', 'indexer-degraded', 'indexer-freshness', 'indexer-reconcile-age')
order by check_key;
rollback;
