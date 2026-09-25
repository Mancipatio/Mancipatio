-- Read-only: the indexer freshness heartbeat (0075) of this project's network.
--   MANCI_TARGET=<t> bash scripts/db.sh -f scripts/ops/indexer-heartbeat-status.sql
-- Reason codes only (runbook §16); no RPC text is ever stored.
begin read only;
select network, mode, interval_seconds, sample_size, reconcile_max_age_hours,
  created_at, last_attempt_at, last_outcome, last_reason, last_proven_at, declined_since, last_expired_at,
  tip_slot, tip_seen_at, planned_at, plan_id is not null as plan_open,
  cardinality(sample_pdas) as sampled, sample_cursor, probe_signatures
from public.indexer_heartbeat_state where network = public.deployment_network();
select program, slot as watermark, resume_slot, resume_signature is not null as catching_up, updated_at
from public.indexer_heartbeat_watermarks where network = public.deployment_network() order by program;
select network, status, last_slot, completed_at, checked_at,
  round(extract(epoch from now() - checked_at)) as checked_age_seconds,
  (status = 'ready' and completed_at is not null
    and checked_at >= now() - interval '5 minutes' and checked_at <= now() + interval '30 seconds') as fresh
from public.indexer_sync_state where network = public.deployment_network();
select count(*) as pending_jobs, min(created_at) as oldest_pending
from public.indexer_jobs where network = public.deployment_network() and status = 'pending';
select check_key, last_fail_at, cleared_at, pass_streak
from public.alarm_incidents
where network = public.deployment_network() and check_key in ('indexer-gap', 'indexer-degraded', 'indexer-freshness', 'indexer-reconcile-age')
order by check_key;
rollback;
