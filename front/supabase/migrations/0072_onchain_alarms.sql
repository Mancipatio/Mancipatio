-- 0072 (Talas 4.4b): on-chain alarms, system alerts with an email outbox,
-- incidents with hysteresis, worker leases and heartbeats.
--
-- EXPAND step: safe with the front that is live when it is applied. Nothing
-- here changes an existing function's signature; acquire_retry_worker_lease
-- keeps its body and only asserts the deployment network first.
--
--  1. public.assert_deployment_network(p_network)
--       The deployment identity stays 0070's (public.deployment_network());
--       this only compares a caller's network with it, by the 0071 guard's
--       rule (D8): equal, or both non-mainnet. Raises
--       DEPLOYMENT_NETWORK_MISMATCH otherwise (and 0070's 55000 while the
--       identity row is missing). Called first by both worker leases.
--  2. compliance_alerts: dedup_key, category and a notification outbox
--       (notify_state pending / sent / skipped / failed). Rows written before
--       this migration keep notify_state null and are never emailed.
--  3. onchain_event_jobs: one job per program transaction the indexer saw,
--       filled by an AFTER INSERT trigger on indexer_events (atomic with the
--       webhook batch; a duplicate delivery inserts no event, so no job).
--  4. worker_leases / worker_heartbeats: the alarm worker's own lease (fate
--       isolation from the retry worker) and both workers' last runs.
--  5. alarm_incidents + report_incident(): fail / hold / pass with
--       hysteresis (3 passes, 5 min since the last failure, 30 min reopen
--       cooldown; D23). Open incidents resolve themselves, escalated ones
--       are left to humans (D9).
--  6. raise_system_alert(): the one writer of system alerts. It has no
--       wallet or client_id parameter (D5), so a system alert never blocks
--       passport issuance (api/compliance/open-wallets).
--       finish_alert_notifications(): the outbox result of one digest
--       (backoff; high and critical never become 'failed').
--  7. Retention task 7: onchain_event_jobs complete / invalid after 90 days.
--
-- Every new table and function is service_role only (RLS on, browser roles
-- revoked). Every new `network` column defaults to
-- public.deployment_network() and carries manci_network_guard (0071 rules).
--
-- Rollback (not a migration): drop trigger indexer_events_enqueue_alarm_job
-- on public.indexer_events; restore 0047's body of
-- acquire_retry_worker_lease (the same body without the first `perform`).
-- Tables and columns stay.
--
-- Re-runnable: every statement is idempotent.
begin;
set local lock_timeout = '15s';

do $$
begin
  if to_regprocedure('public.deployment_network()') is null
     or to_regprocedure('mancipatio_ops.install_network_guards()') is null then
    raise exception 'Apply 0070 and 0071 before 0072';
  end if;
end;
$$;

-- ── 1. Deployment network assertion (reuses 0070's identity) ──────────────
create or replace function public.assert_deployment_network(p_network text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  deployed text := public.deployment_network();
begin
  if p_network is null or p_network not in ('devnet', 'mainnet', 'testnet', 'localnet')
     or (p_network <> deployed and (p_network = 'mainnet' or deployed = 'mainnet')) then
    raise exception 'DEPLOYMENT_NETWORK_MISMATCH database=% deployment=%', deployed, coalesce(p_network, 'null')
      using errcode = 'P0001';
  end if;
  return deployed;
end;
$$;
revoke all on function public.assert_deployment_network(text) from public, anon, authenticated;
grant execute on function public.assert_deployment_network(text) to service_role;

-- 0047's lease, with the assertion first.
create or replace function public.acquire_retry_worker_lease(
  p_network text, p_owner uuid, p_ttl_seconds integer default 120
) returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare acquired integer;
begin
  perform public.assert_deployment_network(p_network);
  if p_network is null or p_network not in ('mainnet', 'devnet', 'testnet', 'localnet')
    or p_owner is null or p_ttl_seconds is null or p_ttl_seconds < 60 or p_ttl_seconds > 300 then
    raise exception 'Invalid retry worker lease parameters' using errcode = '22023';
  end if;
  insert into public.retry_worker_leases as leases(network, owner, expires_at)
    values (p_network, p_owner, clock_timestamp() + make_interval(secs => p_ttl_seconds))
  on conflict (network) do update
    set owner = excluded.owner, expires_at = excluded.expires_at
    where leases.expires_at <= clock_timestamp();
  get diagnostics acquired = row_count;
  return acquired = 1;
end;
$$;
revoke all on function public.acquire_retry_worker_lease(text, uuid, integer) from public, anon, authenticated;
grant execute on function public.acquire_retry_worker_lease(text, uuid, integer) to service_role;

-- ── 2. compliance_alerts: identity, category, outbox ──────────────────────
alter table public.compliance_alerts
  add column if not exists dedup_key text,
  add column if not exists category text,
  add column if not exists notify_state text,
  add column if not exists notify_attempts integer not null default 0,
  add column if not exists next_notify_at timestamptz,
  add column if not exists notified_at timestamptz,
  add column if not exists notified_severity text,
  add column if not exists notify_error text;

alter table public.compliance_alerts
  drop constraint if exists compliance_alerts_dedup_key_format,
  drop constraint if exists compliance_alerts_category_check,
  drop constraint if exists compliance_alerts_notify_state_check,
  drop constraint if exists compliance_alerts_notified_severity_check,
  drop constraint if exists compliance_alerts_notify_error_check,
  drop constraint if exists compliance_alerts_notify_attempts_check;
alter table public.compliance_alerts
  add constraint compliance_alerts_dedup_key_format
    check (dedup_key is null or dedup_key ~ '^(onchain|ledger|incident|test):[A-Za-z0-9:._-]{1,200}$'),
  add constraint compliance_alerts_category_check
    check (category is null or category in ('onchain', 'indexer', 'worker', 'ledger', 'fx')),
  add constraint compliance_alerts_notify_state_check
    check (notify_state is null or notify_state in ('pending', 'sent', 'skipped', 'failed')),
  add constraint compliance_alerts_notified_severity_check
    check (notified_severity is null or notified_severity in ('low', 'medium', 'high', 'critical')),
  add constraint compliance_alerts_notify_error_check
    check (notify_error is null or notify_error ~ '^[A-Z_]{1,40}$'),
  add constraint compliance_alerts_notify_attempts_check
    check (notify_attempts >= 0);

create unique index if not exists compliance_alerts_dedup_once
  on public.compliance_alerts(network, dedup_key) where dedup_key is not null;
create index if not exists compliance_alerts_outbox_idx
  on public.compliance_alerts(network, next_notify_at) where notify_state = 'pending';
create index if not exists compliance_alerts_open_idx
  on public.compliance_alerts(network, status, severity);

comment on column public.compliance_alerts.dedup_key is
  'System alerts only: onchain:<sig>:<ordinal>[:decode], ledger:<id>:<CODE>:<disc>, incident:<check>:<ms>, test:<label>. Unique per network.';
comment on column public.compliance_alerts.notify_state is
  'Email outbox (0072): pending → sent; skipped (low, or not to be emailed); failed (medium after 20 attempts; high and critical never fail). Null on rows older than 0072.';

-- ── 3. onchain_event_jobs ─────────────────────────────────────────────────
create table if not exists public.onchain_event_jobs (
  id uuid primary key default gen_random_uuid(),
  network text not null default public.deployment_network()
    check (network in ('devnet', 'mainnet', 'testnet', 'localnet')),
  signature text not null check (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$'),
  slot bigint check (slot is null or slot >= 0),
  block_time timestamptz,
  source text not null check (source in ('webhook', 'gap-scan')),
  status text not null default 'pending' check (status in ('pending', 'complete', 'invalid')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error text check (last_error is null or last_error ~ '^[A-Z_]{1,40}$'),
  alerts integer not null default 0 check (alerts >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (network, signature)
);
create index if not exists onchain_event_jobs_due_idx
  on public.onchain_event_jobs(network, next_attempt_at) where status = 'pending';
create index if not exists onchain_event_jobs_closed_idx
  on public.onchain_event_jobs(updated_at) where status in ('complete', 'invalid');
alter table public.onchain_event_jobs enable row level security;
revoke all on public.onchain_event_jobs from public, anon, authenticated;
grant all on public.onchain_event_jobs to service_role;

drop trigger if exists onchain_event_jobs_touch on public.onchain_event_jobs;
create trigger onchain_event_jobs_touch before update on public.onchain_event_jobs
  for each row execute function public.touch_updated_at();

comment on table public.onchain_event_jobs is
  'One alarm job per program transaction seen by the indexer (webhook or gap scan). Status and a fixed error code only; never RPC messages.';

-- ── 4. indexer_events → onchain_event_jobs ────────────────────────────────
create or replace function public.indexer_events_enqueue_alarm_job()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Only real signatures (the webhook validates them; other writers may not).
  if new.signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$' then
    insert into public.onchain_event_jobs(network, signature, slot, block_time, source)
    values (new.network, new.signature, new.slot, new.block_time,
      case when new.ix_name = 'GAP_SCAN' and new.payload->>'source' = 'gap-scan' then 'gap-scan' else 'webhook' end)
    on conflict (network, signature) do nothing;
  end if;
  return null;
end;
$$;
revoke all on function public.indexer_events_enqueue_alarm_job() from public, anon, authenticated, service_role;

drop trigger if exists indexer_events_enqueue_alarm_job on public.indexer_events;
create trigger indexer_events_enqueue_alarm_job
  after insert on public.indexer_events
  for each row execute function public.indexer_events_enqueue_alarm_job();

-- ── 5. Worker leases and heartbeats ───────────────────────────────────────
create table if not exists public.worker_leases (
  network text not null default public.deployment_network()
    check (network in ('devnet', 'mainnet', 'testnet', 'localnet')),
  worker text not null check (worker in ('alarms')),
  owner uuid not null,
  expires_at timestamptz not null,
  primary key (network, worker)
);
alter table public.worker_leases enable row level security;
revoke all on public.worker_leases from public, anon, authenticated;
grant all on public.worker_leases to service_role;

create or replace function public.acquire_worker_lease(
  p_network text, p_worker text, p_owner uuid, p_ttl_seconds integer default 120
) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare acquired integer;
begin
  perform public.assert_deployment_network(p_network);
  if p_worker is null or p_worker not in ('alarms') or p_owner is null
     or p_ttl_seconds is null or p_ttl_seconds < 60 or p_ttl_seconds > 300 then
    raise exception 'Invalid worker lease parameters' using errcode = '22023';
  end if;
  insert into public.worker_leases as leases(network, worker, owner, expires_at)
    values (p_network, p_worker, p_owner, clock_timestamp() + make_interval(secs => p_ttl_seconds))
  on conflict (network, worker) do update
    set owner = excluded.owner, expires_at = excluded.expires_at
    where leases.expires_at <= clock_timestamp();
  get diagnostics acquired = row_count;
  return acquired = 1;
end;
$$;

create or replace function public.release_worker_lease(p_network text, p_worker text, p_owner uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare released integer;
begin
  perform public.assert_deployment_network(p_network);
  delete from public.worker_leases where network = p_network and worker = p_worker and owner = p_owner;
  get diagnostics released = row_count;
  return released = 1;
end;
$$;

create table if not exists public.worker_heartbeats (
  network text not null default public.deployment_network()
    check (network in ('devnet', 'mainnet', 'testnet', 'localnet')),
  worker text not null check (worker in ('retry', 'alarms')),
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_ok_at timestamptz,
  last_status text check (last_status in ('processed', 'partial', 'busy')),
  last_gap_scan_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (network, worker)
);
alter table public.worker_heartbeats enable row level security;
revoke all on public.worker_heartbeats from public, anon, authenticated;
grant all on public.worker_heartbeats to service_role;

-- last_ok_at moves only on a fully processed run; a busy or partial run
-- keeps the previous one, so a worker that never finishes cleanly ages out.
create or replace function public.record_worker_heartbeat(
  p_network text, p_worker text, p_status text, p_started_at timestamptz, p_gap_scan boolean default false
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_network is null or p_network not in ('devnet', 'mainnet', 'testnet', 'localnet')
     or p_worker is null or p_worker not in ('retry', 'alarms')
     or p_status is null or p_status not in ('processed', 'partial', 'busy') then
    raise exception 'Invalid worker heartbeat' using errcode = '22023';
  end if;
  insert into public.worker_heartbeats as h(network, worker, last_started_at, last_finished_at, last_ok_at,
    last_status, last_gap_scan_at, updated_at)
  values (p_network, p_worker, p_started_at, now(), case when p_status = 'processed' then now() end,
    p_status, case when coalesce(p_gap_scan, false) then now() end, now())
  on conflict (network, worker) do update set
    last_started_at = coalesce(excluded.last_started_at, h.last_started_at),
    last_finished_at = excluded.last_finished_at,
    last_ok_at = coalesce(excluded.last_ok_at, h.last_ok_at),
    last_status = excluded.last_status,
    last_gap_scan_at = coalesce(excluded.last_gap_scan_at, h.last_gap_scan_at),
    updated_at = now();
end;
$$;

-- ── 6. System alerts ──────────────────────────────────────────────────────
create or replace function public.alarm_severity_rank(p_severity text)
returns integer language sql immutable set search_path = '' as $$
  select coalesce(array_position(array['low', 'medium', 'high', 'critical'], p_severity), 0)
$$;

-- Validation shared by both writers. Raises 22023 with a fixed message.
create or replace function public.alarm_validate(
  p_category text, p_source text, p_severity text, p_summary text, p_evidence jsonb
) returns void
language plpgsql immutable set search_path = ''
as $$
begin
  if p_category is null or p_category not in ('onchain', 'indexer', 'worker', 'ledger', 'fx')
     or p_source is null or p_source !~ '^[a-z]+:[a-z0-9-]{1,50}$'
     or p_severity is null or p_severity not in ('low', 'medium', 'high', 'critical')
     or p_summary is null or length(p_summary) not between 1 and 500
     or p_evidence is null or jsonb_typeof(p_evidence) <> 'object'
     or octet_length(p_evidence::text) > 10240 then
    raise exception 'Invalid system alert' using errcode = '22023';
  end if;
end;
$$;

-- The one writer of system alerts: idempotent on (network, dedup_key). Low
-- alerts are never emailed (D2). No wallet or client_id, by signature (D5).
create or replace function public.raise_system_alert(
  p_network text, p_dedup_key text, p_category text, p_source text, p_severity text,
  p_summary text, p_evidence jsonb, p_tx_signature text, p_notify boolean
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  new_id uuid;
begin
  if p_network is null or p_network not in ('devnet', 'mainnet', 'testnet', 'localnet')
     or p_dedup_key is null or p_dedup_key !~ '^(onchain|ledger|incident|test):[A-Za-z0-9:._-]{1,200}$'
     or (p_tx_signature is not null and p_tx_signature !~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$') then
    raise exception 'Invalid system alert' using errcode = '22023';
  end if;
  perform public.alarm_validate(p_category, p_source, p_severity, p_summary, p_evidence);
  insert into public.compliance_alerts(network, source, severity, confidence, evidence, summary, status,
    tx_signature, dedup_key, category, notify_state, next_notify_at)
  values (p_network, p_source, p_severity, 100, p_evidence, p_summary, 'open', p_tx_signature, p_dedup_key,
    p_category, case when coalesce(p_notify, false) and p_severity <> 'low' then 'pending' else 'skipped' end, now())
  on conflict (network, dedup_key) where dedup_key is not null do nothing
  returning id into new_id;
  if new_id is not null then
    return jsonb_build_object('id', new_id, 'inserted', true);
  end if;
  select id into new_id from public.compliance_alerts where network = p_network and dedup_key = p_dedup_key;
  return jsonb_build_object('id', new_id, 'inserted', false);
end;
$$;

-- The outbox result of one digest. p_rows: [{id, severity}] as the digest
-- read them (a row whose severity rose since stays pending and is sent
-- again). Sent: notified at that severity. Failed: backoff
-- min(60 s * 2^attempts, 30 min); low and medium rows become 'failed' after
-- 20 attempts; high and critical never give up.
create or replace function public.finish_alert_notifications(
  p_network text, p_rows jsonb, p_sent boolean, p_error text
) returns integer
language plpgsql security definer set search_path = ''
as $$
declare changed integer;
begin
  if p_network is null or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 100
     or (not coalesce(p_sent, false) and (p_error is null or p_error !~ '^[A-Z_]{1,40}$')) then
    raise exception 'Invalid notification result' using errcode = '22023';
  end if;
  if p_sent then
    update public.compliance_alerts a
       set notify_state = 'sent', notified_at = now(), notified_severity = a.severity, notify_error = null
      from jsonb_to_recordset(p_rows) as x(id uuid, severity text)
     where a.id = x.id and a.network = p_network and a.notify_state = 'pending' and a.severity = x.severity;
  else
    update public.compliance_alerts a
       set notify_attempts = a.notify_attempts + 1,
           next_notify_at = now() + make_interval(secs => least(60 * power(2, least(a.notify_attempts, 10)), 1800)),
           notify_error = p_error,
           notify_state = case when a.severity in ('low', 'medium') and a.notify_attempts + 1 >= 20 then 'failed' else 'pending' end
      from jsonb_to_recordset(p_rows) as x(id uuid, severity text)
     where a.id = x.id and a.network = p_network and a.notify_state = 'pending';
  end if;
  get diagnostics changed = row_count;
  return changed;
end;
$$;

-- ── 7. Incidents with hysteresis ──────────────────────────────────────────
create table if not exists public.alarm_incidents (
  network text not null default public.deployment_network()
    check (network in ('devnet', 'mainnet', 'testnet', 'localnet')),
  check_key text not null
    check (check_key ~ '^[a-z0-9-]{1,40}(:[1-9A-HJ-NP-Za-km-z]{32,44}|:(spv|issuer):[A-Za-z0-9-]{1,64})?$'),
  alert_id uuid references public.compliance_alerts(id) on delete set null,
  pass_streak integer not null default 0 check (pass_streak >= 0),
  last_fail_at timestamptz,
  cleared_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (network, check_key)
);
alter table public.alarm_incidents enable row level security;
revoke all on public.alarm_incidents from public, anon, authenticated;
grant all on public.alarm_incidents to service_role;

-- One check's state change. fail: open or update the incident's alert;
-- hold: the condition is not decided (keeps it, resets the pass streak);
-- pass: after 3 passes and 5 minutes since the last failure, the incident is
-- cleared and an OPEN alert resolved (escalated ones stay with humans, D9).
-- A failure within 30 minutes of a clear reopens the same alert silently when
-- the system resolved it; an alert a person resolved or dismissed is kept as
-- it is and a new alert opens. Returns {action, alert_id}.
create or replace function public.report_incident(
  p_network text, p_check text, p_state text, p_category text, p_source text, p_severity text,
  p_summary text, p_evidence jsonb, p_notify boolean
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  inc public.alarm_incidents%rowtype;
  a public.compliance_alerts%rowtype;
  have_alert boolean := false;
  new_id uuid;
  action text;
  notify boolean := coalesce(p_notify, false) and p_severity <> 'low';
  rises boolean;
begin
  if p_network is null or p_network not in ('devnet', 'mainnet', 'testnet', 'localnet')
     or p_check is null or p_check !~ '^[a-z0-9-]{1,40}(:[1-9A-HJ-NP-Za-km-z]{32,44}|:(spv|issuer):[A-Za-z0-9-]{1,64})?$'
     or p_state is null or p_state not in ('fail', 'hold', 'pass') then
    raise exception 'Invalid incident report' using errcode = '22023';
  end if;
  perform public.alarm_validate(p_category, p_source, p_severity, p_summary, coalesce(p_evidence, '{}'::jsonb));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('incident:' || p_network || ':' || p_check, 0));
  insert into public.alarm_incidents(network, check_key) values (p_network, p_check)
    on conflict (network, check_key) do nothing;
  select * into inc from public.alarm_incidents where network = p_network and check_key = p_check for update;
  if inc.alert_id is not null then
    select * into a from public.compliance_alerts where id = inc.alert_id for update;
    have_alert := found;
  end if;

  if p_state = 'hold' then
    update public.alarm_incidents set pass_streak = 0, updated_at = now()
     where network = p_network and check_key = p_check;
    return jsonb_build_object('action', 'hold', 'alert_id', inc.alert_id);
  end if;

  if p_state = 'pass' then
    if inc.last_fail_at is null or inc.cleared_at is not null then
      update public.alarm_incidents set pass_streak = least(pass_streak + 1, 1000000), updated_at = now()
       where network = p_network and check_key = p_check;
      return jsonb_build_object('action', 'pass', 'alert_id', inc.alert_id);
    end if;
    if inc.pass_streak + 1 >= 3 and inc.last_fail_at < now() - interval '5 minutes' then
      update public.alarm_incidents set pass_streak = pass_streak + 1, cleared_at = now(), updated_at = now()
       where network = p_network and check_key = p_check;
      if have_alert and a.status = 'open' then
        update public.compliance_alerts
           set status = 'resolved', resolved_by = 'system', resolved_at = now(),
               resolution_note = 'Recovered automatically',
               evidence = evidence || jsonb_build_object('cleared_at', now())
         where id = a.id;
      end if;
      return jsonb_build_object('action', 'cleared', 'alert_id', inc.alert_id);
    end if;
    update public.alarm_incidents set pass_streak = pass_streak + 1, updated_at = now()
     where network = p_network and check_key = p_check;
    return jsonb_build_object('action', 'pass', 'alert_id', inc.alert_id);
  end if;

  -- fail
  rises := have_alert and public.alarm_severity_rank(p_severity) > public.alarm_severity_rank(a.severity);
  if have_alert and a.status in ('open', 'escalated') then
    -- (a) Ongoing: merge; a higher severity is raised and notified again.
    update public.compliance_alerts
       set evidence = evidence || coalesce(p_evidence, '{}'::jsonb) || jsonb_build_object(
             'last_seen_at', now(), 'fail_count', coalesce((evidence->>'fail_count')::integer, 1) + 1),
           summary = p_summary,
           severity = case when rises then p_severity else severity end,
           notify_state = case when rises and notify then 'pending' else notify_state end,
           notify_attempts = case when rises and notify then 0 else notify_attempts end,
           next_notify_at = case when rises and notify then now() else next_notify_at end
     where id = a.id;
    action := case when rises then 'raised' else 'updated' end;
    new_id := a.id;
  elsif have_alert and inc.cleared_at is null and a.status in ('resolved', 'dismissed') then
    -- (b) A human acknowledged an ongoing condition: silent unless it got worse.
    if rises then
      action := 'opened';
    else
      update public.alarm_incidents set pass_streak = 0, last_fail_at = now(), updated_at = now()
       where network = p_network and check_key = p_check;
      return jsonb_build_object('action', 'acknowledged', 'alert_id', a.id);
    end if;
  elsif have_alert and inc.cleared_at is not null and inc.cleared_at > now() - interval '30 minutes'
        and a.status = 'resolved' and a.resolved_by = 'system' then
    -- (c) Flapping: reopen the same alert, without a new email unless it got
    -- worse. Only an alert the system resolved: a person's resolution or
    -- dismissal (and its note) is never overwritten; that case opens a new
    -- alert (d).
    update public.compliance_alerts
       set status = 'open', resolved_by = null, resolved_at = null, resolution_note = null,
           summary = p_summary,
           evidence = evidence || coalesce(p_evidence, '{}'::jsonb) || jsonb_build_object(
             'last_seen_at', now(), 'reopened', coalesce((evidence->>'reopened')::integer, 0) + 1),
           severity = case when rises then p_severity else severity end,
           notify_state = case when rises and notify then 'pending' else notify_state end,
           notify_attempts = case when rises and notify then 0 else notify_attempts end,
           next_notify_at = case when rises and notify then now() else next_notify_at end
     where id = a.id;
    action := 'reopened';
    new_id := a.id;
  else
    action := 'opened';
  end if;

  if action = 'opened' then
    insert into public.compliance_alerts(network, source, severity, confidence, evidence, summary, status,
      dedup_key, category, notify_state, next_notify_at)
    values (p_network, p_source, p_severity, 100,
      coalesce(p_evidence, '{}'::jsonb) || jsonb_build_object('check', p_check, 'first_seen_at', now(), 'fail_count', 1),
      p_summary, 'open',
      'incident:' || p_check || ':' || floor(extract(epoch from clock_timestamp()) * 1000)::bigint::text,
      p_category, case when notify then 'pending' else 'skipped' end, now())
    returning id into new_id;
  end if;

  update public.alarm_incidents
     set pass_streak = 0, last_fail_at = now(), cleared_at = null, alert_id = new_id, updated_at = now()
   where network = p_network and check_key = p_check;
  return jsonb_build_object('action', action, 'alert_id', new_id);
end;
$$;

-- ── 8. Retention task 7 (0063's list plus onchain_event_jobs) ─────────────
create or replace function mancipatio_ops.retention_tasks()
returns table(
  task_position integer, task_name text, relation text, key_column text,
  candidates text, order_column text, change text, lock_rows boolean, optional boolean
)
language sql immutable set search_path = ''
as $$
  values
    (1, 'indexer_jobs', 'public.indexer_jobs', 'id',
      $p$status = 'complete' and updated_at < now() - interval '30 days'$p$,
      'updated_at', 'delete', true, false),
    (2, 'indexer_event_payloads', 'public.indexer_events', 'id',
      $p$payload <> '{}'::jsonb and wallets is not null and decoded and created_at < now() - interval '90 days'$p$,
      'created_at', $p$set payload = '{}'::jsonb$p$, true, false),
    (3, 'purchase_evidence_jobs', 'public.purchase_evidence_jobs', 'id',
      $p$status in ('complete', 'invalid') and updated_at < now() - interval '90 days'$p$,
      'updated_at', 'delete', true, false),
    (4, 'auth_login_tokens', 'public.auth_login_tokens', 'token_hash',
      $p$expires_at < now()$p$,
      'expires_at', 'delete', true, false),
    (5, 'auth_google_states', 'public.auth_google_states', 'state_hash',
      $p$expires_at < now()$p$,
      'expires_at', 'delete', true, false),
    (6, 'cron_job_run_details', 'cron.job_run_details', 'runid',
      $p$jobid in (select j.jobid from cron.job j where j.jobname like 'mancipatio-%') and coalesce(end_time, start_time) < now() - interval '7 days'$p$,
      'runid', 'delete', false, true),
    (7, 'onchain_event_jobs', 'public.onchain_event_jobs', 'id',
      $p$status in ('complete', 'invalid') and updated_at < now() - interval '90 days'$p$,
      'updated_at', 'delete', true, false)
$$;
revoke all on function mancipatio_ops.retention_tasks() from public, anon, authenticated, service_role;

-- ── 9. Grants ─────────────────────────────────────────────────────────────
revoke all on function
  public.acquire_worker_lease(text, text, uuid, integer),
  public.release_worker_lease(text, text, uuid),
  public.record_worker_heartbeat(text, text, text, timestamptz, boolean),
  public.alarm_severity_rank(text),
  public.alarm_validate(text, text, text, text, jsonb),
  public.raise_system_alert(text, text, text, text, text, text, jsonb, text, boolean),
  public.finish_alert_notifications(text, jsonb, boolean, text),
  public.report_incident(text, text, text, text, text, text, text, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function
  public.acquire_worker_lease(text, text, uuid, integer),
  public.release_worker_lease(text, text, uuid),
  public.record_worker_heartbeat(text, text, text, timestamptz, boolean),
  public.alarm_severity_rank(text),
  public.alarm_validate(text, text, text, text, jsonb),
  public.raise_system_alert(text, text, text, text, text, text, jsonb, text, boolean),
  public.finish_alert_notifications(text, jsonb, boolean, text),
  public.report_incident(text, text, text, text, text, text, text, jsonb, boolean)
  to service_role;

select mancipatio_ops.install_network_guards();

notify pgrst, 'reload schema';

commit;
