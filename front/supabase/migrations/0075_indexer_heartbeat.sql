-- 0075: indexer freshness heartbeat (design:
-- docs/mainnet-readiness/indexer-heartbeat-design.md, with its critique).
--
-- indexer_sync_state.checked_at moves only when an indexer job completes
-- (0047 finish_indexer_job) or a full reconcile runs, so on a quiet network
-- the mirror turns stale 5 minutes after the last program transaction: the
-- site falls back to RPC reads and the indexer-backed admin badges go muted.
-- The heartbeat (retry worker, indexer stage, lib/server/indexer-heartbeat.ts)
-- extends checked_at ONLY when this SQL proves, from chain evidence gathered
-- in the same run, that the mirror is still in sync. Anything uncertain
-- leaves checked_at alone: the mirror goes stale and the site reads the chain.
--
--   1. indexer_heartbeat_programs(): the programs the proof covers (the
--      0047 / webhook literals; tests/indexer-heartbeat.test.ts pins every copy).
--   2. indexer_heartbeat_state: one row per network. mode off / observe / on
--      (seeded 'observe': evaluate and record, never bump), the plan of the
--      current run, the last tip observation, the account sample and its
--      cursor, the probe candidates, and the last outcome and reason code.
--   3. indexer_heartbeat_watermarks: per network and program. `slot`: every
--      successful transaction of that program at or below it is decoded in
--      indexer_events (or reflected by the full reconcile at last_slot); it
--      only moves up. `resume_*`: where a listing that did not reach the
--      floor continues on the next run (catch-up after a burst).
--      Operator reset: delete the program's row (the floor falls back to
--      indexer_sync_state.last_slot; run a full reconcile to raise it).
--   4. indexer_heartbeat_plan(): starts one run when due (interval_seconds),
--      stamps its database time and returns the floors, cursors, the account
--      sample and the probe candidates.
--   5. confirm_indexer_quiet(): under the indexer_sync_state row lock that
--      finish_indexer_job (0047) and the full reconcile upsert also take, it
--      judges that run's evidence, advances watermarks, and bumps checked_at
--      to the plan's database time ONLY when every condition holds. In mode
--      'on' it also EXPIRES freshness (checked_at moved back past the 5-minute
--      window, status untouched) when a program transaction older than about
--      a minute is missing from indexer_events. It never writes status,
--      last_slot or completed_at.
--
-- The proof (first failing condition = the recorded reason code):
--   plan      the confirm answers the latest plan (PLAN_SUPERSEDED, no
--             writes) within 30 s of it (PLAN_EXPIRED)
--   P1        sync row exists, status 'ready', a completed reconcile with a
--             last_slot, not older than reconcile_max_age_hours (NOT_INITIALIZED,
--             NOT_READY, NOT_RECONCILED, RECONCILE_TOO_OLD)
--   P2        no pending indexer job: pending, retrying and leased are all
--             status 'pending' in 0047 (PENDING_JOBS)
--   P3        no open indexer-gap / indexer-degraded incident (OPEN_INCIDENT)
--   P4        the confirmed tip moved 1..4 slots/s (+150) since the previous
--             observation, taken 20 s..5 min earlier (TIP_BASELINE,
--             TIP_TOO_SOON, RPC_BEHIND, RPC_TIP_IMPLAUSIBLE, RPC_TIP_STALLED)
--   S4        no event delivered 1-10 min ago has a slot above every listed
--             row: the RPC's signature index would be behind (RPC_INDEX_BEHIND)
--   P5        per program, the listing reaches the floor
--             greatest(watermark, last_slot): its OLDEST row has a slot at or
--             below it. A short or empty page proves nothing (the node's
--             history may be cut short) and a null floor never passes
--             (LISTING_INCOMPLETE; CATCHING_UP while paging from a cursor;
--             CURSOR_MOVED)
--   P6        every successful, non-exempt listed row above the floor is in
--             indexer_events for the network, decoded, with a non-null event
--             slot equal to the listed slot (UNINDEXED_SIGNATURE,
--             UNDECODED_SIGNATURE, UNPROVEN_EVENT_SLOT, SLOT_MISMATCH).
--             Failed rows are never required. A row is exempt only when this
--             function named it a probe candidate in the previous run and the
--             worker's finalized getTransaction showed it invokes no watched
--             program (it only lists the program ID or loads it via a lookup
--             table: it cannot change a program account).
--   S1        a rotating sample of up to sample_size mirrored accounts, read
--             at finalized, equals the stored raw data (SAMPLE_MISMATCH; the
--             cursor stays so the same batch is checked again)
--   P7        mode 'on' (observe: would_bump; OFF)
--
-- Watermarks advance only on a live tip (P4) with a current index (S4) and a
-- listing complete down to the floor, to the highest listed slot below the
-- first unproven row (failed and exempt rows count as proven), capped at the
-- confirmed tip - 150 and at the finalized slot of the same run.
--
-- Every table and function is service_role only. Network columns follow the
-- 0071 rules (dynamic default, guard, seeded with deployment_network()).
--
-- Rollback (not a migration): update public.indexer_heartbeat_state set
-- mode = 'observe' (no bumps) or 'off' (no RPC calls either). A front revert
-- leaves the tables inert. Re-runnable: every statement is idempotent.
begin;
set local lock_timeout = '15s';

do $$
begin
  if to_regprocedure('public.assert_deployment_network(text)') is null
     or to_regprocedure('mancipatio_ops.install_network_guards()') is null
     or to_regclass('public.alarm_incidents') is null
     or to_regclass('public.indexer_account_versions') is null
     or to_regprocedure('public.finish_indexer_job(uuid,uuid,boolean,text)') is null then
    raise exception 'Apply 0047 and 0070-0072 before 0075';
  end if;
end;
$$;

-- ── 1. The programs the proof covers ──────────────────────────────────────
-- asset_registry FIRST (the owner of every mirrored account; the sample
-- compares against it), then transfer_hook.
create or replace function public.indexer_heartbeat_programs()
returns text[] language sql immutable set search_path = '' as $$
  select array['FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS',
               'GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy']::text[]
$$;

-- ── 2. Tables ─────────────────────────────────────────────────────────────
create table if not exists public.indexer_heartbeat_state (
  network text primary key default public.deployment_network()
    check (network in ('devnet', 'mainnet', 'testnet', 'localnet')),
  mode text not null default 'observe' check (mode in ('off', 'observe', 'on')),
  interval_seconds integer not null default 120 check (interval_seconds between 60 and 180),
  sample_size integer not null default 100 check (sample_size between 0 and 100),
  reconcile_max_age_hours integer not null default 168 check (reconcile_max_age_hours between 1 and 2160),
  plan_id uuid,
  planned_at timestamptz,
  sample_pdas text[] not null default '{}' check (cardinality(sample_pdas) <= 100),
  sample_cursor text check (sample_cursor is null or sample_cursor ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  probe_signatures text[] not null default '{}' check (cardinality(probe_signatures) <= 2),
  tip_slot bigint check (tip_slot is null or tip_slot >= 0),
  tip_seen_at timestamptz,
  last_attempt_at timestamptz,
  last_outcome text check (last_outcome is null or last_outcome in ('bumped', 'would_bump', 'declined')),
  last_reason text check (last_reason is null or last_reason ~ '^[A-Z_]{1,40}$'),
  last_proven_at timestamptz,
  last_expired_at timestamptz,
  declined_since timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.indexer_heartbeat_state enable row level security;
revoke all on public.indexer_heartbeat_state from public, anon, authenticated;
grant all on public.indexer_heartbeat_state to service_role;
comment on table public.indexer_heartbeat_state is
  'Indexer freshness heartbeat (0075), one row per network. mode: off | observe (evaluate, never bump) | on. Reason codes only, never RPC messages.';

create table if not exists public.indexer_heartbeat_watermarks (
  network text not null default public.deployment_network()
    check (network in ('devnet', 'mainnet', 'testnet', 'localnet')),
  program text not null check (program ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  slot bigint check (slot is null or slot >= 0),
  resume_signature text check (resume_signature is null or resume_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$'),
  resume_slot bigint check (resume_slot is null or resume_slot >= 0),
  updated_at timestamptz not null default now(),
  primary key (network, program),
  check ((resume_signature is null) = (resume_slot is null))
);
alter table public.indexer_heartbeat_watermarks enable row level security;
revoke all on public.indexer_heartbeat_watermarks from public, anon, authenticated;
grant all on public.indexer_heartbeat_watermarks to service_role;
comment on table public.indexer_heartbeat_watermarks is
  'Per program: every successful transaction at or below slot is decoded in indexer_events (0075). Only moves up; delete the row to reset.';

insert into public.indexer_heartbeat_state(network) values (public.deployment_network())
  on conflict (network) do nothing;

-- ── 3. Plan: one run, when due ────────────────────────────────────────────
-- Returns {mode, due} and, when due, the plan the run confirms against:
-- plan_id, planned_at (database time), floors and cursors per program, the
-- account sample (indexer_account_versions after the cursor, wrapping) and
-- the probe candidates the previous confirm named.
create or replace function public.indexer_heartbeat_plan(p_network text)
returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s'
as $$
declare
  hb public.indexer_heartbeat_state%rowtype;
  sync public.indexer_sync_state%rowtype;
  now_ts timestamptz := clock_timestamp();
  pid uuid := gen_random_uuid();
  sample text[];
  floors jsonb;
  resume jsonb;
begin
  perform public.assert_deployment_network(p_network);
  insert into public.indexer_heartbeat_state(network) values (p_network) on conflict (network) do nothing;
  select * into hb from public.indexer_heartbeat_state where network = p_network for update;
  if hb.mode = 'off' then
    return jsonb_build_object('mode', 'off', 'due', false);
  end if;
  if hb.planned_at is not null and hb.planned_at <= now_ts
     and hb.planned_at > now_ts - make_interval(secs => hb.interval_seconds - 5) then
    return jsonb_build_object('mode', hb.mode, 'due', false);
  end if;
  select * into sync from public.indexer_sync_state where network = p_network;
  select jsonb_object_agg(p, greatest(w.slot, sync.last_slot)),
         jsonb_object_agg(p, case
           when w.resume_signature is not null
                and w.resume_slot > coalesce(greatest(w.slot, sync.last_slot), -1)
           then jsonb_build_object('signature', w.resume_signature, 'slot', w.resume_slot) end)
    into floors, resume
    from unnest(public.indexer_heartbeat_programs()) p
    left join public.indexer_heartbeat_watermarks w on w.network = p_network and w.program = p;
  sample := array(
    select v.pda from public.indexer_account_versions v
     where v.network = p_network and not v.closed and v.table_name is not null
       and (hb.sample_cursor is null or v.pda > hb.sample_cursor)
     order by v.pda limit hb.sample_size);
  if cardinality(sample) < hb.sample_size and hb.sample_cursor is not null then
    sample := sample || array(
      select v.pda from public.indexer_account_versions v
       where v.network = p_network and not v.closed and v.table_name is not null and v.pda <= hb.sample_cursor
       order by v.pda limit hb.sample_size - cardinality(sample));
  end if;
  update public.indexer_heartbeat_state
     set plan_id = pid, planned_at = now_ts, sample_pdas = sample, updated_at = now_ts
   where network = p_network;
  return jsonb_build_object('mode', hb.mode, 'due', true, 'plan_id', pid, 'planned_at', now_ts,
    'floors', floors, 'resume', resume, 'sample', to_jsonb(sample), 'probe', to_jsonb(hb.probe_signatures));
end;
$$;

-- ── 4. Confirm: judge the evidence of one run ─────────────────────────────
-- p_client_reason (RPC_ERROR, RPC_TIMEOUT, NO_BUDGET): the worker gathered no
-- evidence; recorded, never bumps. Otherwise the evidence of this run:
--   p_tip_slot   getSlot('confirmed'), read after the plan
--   p_listings   [{program, before: signature|null, rows: [{signature, slot, ok}]}],
--                one per program, getSignaturesForAddress pages in RPC order
--                (newest first; failed rows included with ok = false)
--   p_sample     {context_slot, accounts: [{pda, owner|null, data|null}]}:
--                getMultipleAccounts at finalized of exactly the planned sample
--   p_exempt     probe candidates that invoke no watched program
-- Malformed evidence raises 22023 (the worker counts it as DB_ERROR).
create or replace function public.confirm_indexer_quiet(
  p_network text, p_plan_id uuid, p_client_reason text,
  p_tip_slot bigint, p_listings jsonb, p_sample jsonb, p_exempt text[]
) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s'
as $$
declare
  settle constant bigint := 150;            -- ~60 s: watermarks stay out of the newest minute; older misses expire
  plan_ttl constant interval := interval '30 seconds';
  mirror_tables constant text[] := array['platforms', 'issuers', 'assets', 'share_classes', 'sales', 'custody_vaults',
    'offers', 'proposals', 'vote_records', 'rights_issuances', 'milestones', 'milestone_claims', 'kyc_registries', 'kyc_entries'];
  sig_re constant text := '^[1-9A-HJ-NP-Za-km-z]{64,96}$';
  addr_re constant text := '^[1-9A-HJ-NP-Za-km-z]{32,44}$';
  slot_re constant text := '^[0-9]{1,16}$';
  programs constant text[] := public.indexer_heartbeat_programs();
  now_ts timestamptz := clock_timestamp();
  sync public.indexer_sync_state%rowtype;
  sync_found boolean;
  hb public.indexer_heartbeat_state%rowtype;
  wm public.indexer_heartbeat_watermarks%rowtype;
  wm_found boolean;
  evidence boolean := p_client_reason is null;
  reason text;
  tip_reason text;
  store_tip boolean := false;
  tip_ok boolean := false;
  index_behind boolean := false;
  can_advance boolean := false;
  elapsed numeric;
  finalized bigint;
  newest bigint;
  exempt text[] := '{}';
  candidates text[] := '{}';
  expire boolean := false;
  expired boolean := false;
  prog text;
  item jsonb;
  resume_mode boolean;
  fl bigint;
  oldest bigint;
  complete boolean;
  gap_kind text;
  top bigint;
  prog_candidates text[];
  prog_expire boolean;
  cap bigint;
  new_slot bigint;
  new_resume_sig text;
  new_resume_slot bigint;
  sample_ok boolean := true;
  new_cursor text;
  acct jsonb;
  ver public.indexer_account_versions%rowtype;
  m_data text;
  m_slot bigint;
  n integer;
  outcome text;
begin
  perform public.assert_deployment_network(p_network);

  -- Validation. Every check is written so that a NULL fails it.
  if p_plan_id is null
     or (p_client_reason is not null and p_client_reason not in ('RPC_ERROR', 'RPC_TIMEOUT', 'NO_BUDGET')) then
    raise exception 'Invalid heartbeat evidence' using errcode = '22023';
  end if;
  if evidence then
    if p_tip_slot is null or p_tip_slot < 0 or p_tip_slot > 9007199254740991
       or jsonb_typeof(p_listings) is distinct from 'array'
       or jsonb_array_length(p_listings) <> cardinality(programs) then
      raise exception 'Invalid heartbeat evidence' using errcode = '22023';
    end if;
    for item in select value from jsonb_array_elements(p_listings) loop
      if jsonb_typeof(item) is distinct from 'object'
         or jsonb_typeof(item->'program') is distinct from 'string'
         or not ((item->>'program') = any(programs))
         or jsonb_typeof(item->'rows') is distinct from 'array'
         or (case coalesce(jsonb_typeof(item->'before'), 'null')
               when 'null' then false
               when 'string' then (item->>'before') !~ sig_re
               else true end) then
        raise exception 'Invalid heartbeat evidence' using errcode = '22023';
      end if;
      if jsonb_array_length(item->'rows') > 300
         or exists (select 1 from jsonb_array_elements(item->'rows') r where coalesce(
              jsonb_typeof(r) <> 'object'
              or jsonb_typeof(r->'signature') is distinct from 'string' or (r->>'signature') !~ sig_re
              or jsonb_typeof(r->'slot') is distinct from 'number' or (r->>'slot') !~ slot_re
              or jsonb_typeof(r->'ok') is distinct from 'boolean', true)) then
        raise exception 'Invalid heartbeat evidence' using errcode = '22023';
      end if;
      -- One row per signature, in RPC order (slots never increase).
      if (select count(*) <> count(distinct r->>'signature') from jsonb_array_elements(item->'rows') r)
         or exists (select 1 from (
              select (r->>'slot')::bigint as slot, lag((r->>'slot')::bigint) over (order by o) as prev
                from jsonb_array_elements(item->'rows') with ordinality x(r, o)) t
              where t.slot > t.prev) then
        raise exception 'Invalid heartbeat evidence' using errcode = '22023';
      end if;
    end loop;
    if (select count(distinct e->>'program') from jsonb_array_elements(p_listings) e) <> cardinality(programs) then
      raise exception 'Invalid heartbeat evidence' using errcode = '22023';
    end if;
    if jsonb_typeof(p_sample) is distinct from 'object'
       or jsonb_typeof(p_sample->'context_slot') is distinct from 'number'
       or coalesce((p_sample->>'context_slot') !~ slot_re, true)
       or jsonb_typeof(p_sample->'accounts') is distinct from 'array' then
      raise exception 'Invalid heartbeat evidence' using errcode = '22023';
    end if;
    if jsonb_array_length(p_sample->'accounts') > 100
       or exists (select 1 from jsonb_array_elements(p_sample->'accounts') a where coalesce(
            jsonb_typeof(a) <> 'object'
            or jsonb_typeof(a->'pda') is distinct from 'string' or (a->>'pda') !~ addr_re
            or jsonb_typeof(a->'owner') not in ('null', 'string')
            or jsonb_typeof(a->'data') not in ('null', 'string')
            or jsonb_typeof(a->'owner') <> jsonb_typeof(a->'data')
            or (jsonb_typeof(a->'owner') = 'string' and ((a->>'owner') !~ addr_re
                or length(a->>'data') > 1400000 or (a->>'data') !~ '^[A-Za-z0-9+/]*={0,2}$')), true))
       or (select count(*) <> count(distinct a->>'pda') from jsonb_array_elements(p_sample->'accounts') a) then
      raise exception 'Invalid heartbeat evidence' using errcode = '22023';
    end if;
    if cardinality(coalesce(p_exempt, '{}')) > 2
       or exists (select 1 from unnest(coalesce(p_exempt, '{}')) x where x is null or x !~ sig_re) then
      raise exception 'Invalid heartbeat evidence' using errcode = '22023';
    end if;
  end if;

  -- Same row as 0047 finish_indexer_job and the reconcile upsert. A
  -- concurrent job verdict or reconcile lands wholly before this decision
  -- (and is seen) or after it (and wins). finish_indexer_job flips its job to
  -- complete BEFORE it waits here, so its job still reads as pending (P2).
  -- Lock order: sync row, state row, watermark rows (no other writer takes
  -- the last two), so there is no cycle.
  select * into sync from public.indexer_sync_state where network = p_network for update;
  sync_found := found;
  select * into hb from public.indexer_heartbeat_state where network = p_network for update;
  if not found or hb.plan_id is distinct from p_plan_id then
    -- Another run planned since (or this plan was already answered): no writes.
    return jsonb_build_object('outcome', 'declined', 'reason', 'PLAN_SUPERSEDED', 'expired', false);
  end if;
  reason := p_client_reason;
  if evidence and (hb.planned_at is null or hb.planned_at > now_ts or now_ts - hb.planned_at > plan_ttl) then
    reason := 'PLAN_EXPIRED';
    evidence := false;
  end if;
  if evidence and (select coalesce(array_agg(x order by x), '{}') from unnest(hb.sample_pdas) x)
      is distinct from (select coalesce(array_agg(a->>'pda' order by a->>'pda'), '{}')
                          from jsonb_array_elements(p_sample->'accounts') a) then
    raise exception 'Invalid heartbeat evidence' using errcode = '22023';
  end if;

  if evidence then
    -- P1, P2, P3.
    if not sync_found then reason := 'NOT_INITIALIZED';
    elsif sync.status is distinct from 'ready' then reason := 'NOT_READY';
    elsif sync.completed_at is null or sync.last_slot is null then reason := 'NOT_RECONCILED';
    elsif sync.completed_at < now_ts - make_interval(hours => hb.reconcile_max_age_hours) then reason := 'RECONCILE_TOO_OLD';
    end if;
    if reason is null and exists (select 1 from public.indexer_jobs where network = p_network and status = 'pending') then
      reason := 'PENDING_JOBS';
    end if;
    if reason is null and exists (select 1 from public.alarm_incidents
        where network = p_network and check_key in ('indexer-gap', 'indexer-degraded')
          and cleared_at is null and last_fail_at is not null) then
      reason := 'OPEN_INCIDENT';
    end if;

    -- P4: the tip against the previous observation (both at plan time).
    elapsed := extract(epoch from hb.planned_at - hb.tip_seen_at);
    if hb.tip_slot is null or elapsed is null or elapsed > 300 or elapsed < 0 then
      tip_reason := 'TIP_BASELINE'; store_tip := true;                   -- first reading: store, never bump
    elsif elapsed < 20 then
      tip_reason := 'TIP_TOO_SOON';                                      -- too close to judge a rate
    elsif p_tip_slot < hb.tip_slot then
      tip_reason := 'RPC_BEHIND';                                        -- kept: expires with the observation
    elsif p_tip_slot - hb.tip_slot > ceil(elapsed * 4) + 150 then
      tip_reason := 'RPC_TIP_IMPLAUSIBLE';                               -- never stored
    elsif p_tip_slot - hb.tip_slot < floor(elapsed) then
      tip_reason := 'RPC_TIP_STALLED'; store_tip := true;                -- stored: a stuck node keeps failing
    else
      tip_ok := true; store_tip := true;
    end if;
    if tip_reason is not null then reason := coalesce(reason, tip_reason); end if;
    finalized := (p_sample->>'context_slot')::bigint;

    -- S4: an event delivered 1-10 minutes ago above every listed row means
    -- the RPC's signature index is behind the webhook (tip listings only).
    if not exists (select 1 from jsonb_array_elements(p_listings) e where jsonb_typeof(e->'before') = 'string') then
      newest := (select max((r->>'slot')::bigint) from jsonb_array_elements(p_listings) e, jsonb_array_elements(e->'rows') r);
      index_behind := exists (select 1 from public.indexer_events ev
        where ev.network = p_network
          and ev.created_at >= now_ts - interval '10 minutes' and ev.created_at <= now_ts - interval '60 seconds'
          and ev.slot is not null and ev.slot > coalesce(newest, -1));
    end if;
    if index_behind then reason := coalesce(reason, 'RPC_INDEX_BEHIND'); end if;
    can_advance := tip_ok and not index_behind;

    exempt := array(select x from unnest(coalesce(p_exempt, '{}')) x where x = any(hb.probe_signatures));

    -- P5, P6 and the watermarks, per program.
    foreach prog in array programs loop
      select value into item from jsonb_array_elements(p_listings) where value->>'program' = prog;
      select * into wm from public.indexer_heartbeat_watermarks where network = p_network and program = prog for update;
      wm_found := found;
      fl := greatest(wm.slot, sync.last_slot);                          -- null only when neither exists
      resume_mode := jsonb_typeof(item->'before') = 'string';
      if resume_mode and not (wm_found and wm.resume_slot is not null
                              and wm.resume_signature is not distinct from item->>'before') then
        reason := coalesce(reason, 'CURSOR_MOVED');
        continue;
      end if;
      -- M1: complete only when the OLDEST row is at or below a known floor.
      oldest := (select min((r->>'slot')::bigint) from jsonb_array_elements(item->'rows') r);
      complete := fl is not null and oldest is not null and oldest <= fl;
      if resume_mode then reason := coalesce(reason, 'CATCHING_UP');
      elsif not complete then reason := coalesce(reason, 'LISTING_INCOMPLETE');
      end if;
      -- No floor (never reconciled, no watermark): nothing is required,
      -- probed, expired or advanced. P1 declines such a network anyway.
      if fl is null then continue; end if;

      with listed as (
        select r->>'signature' as sig, (r->>'slot')::bigint as slot, (r->>'ok')::boolean as ok
          from jsonb_array_elements(item->'rows') r
      ), judged as (
        select l.sig, l.slot,
               l.ok and e.signature is null as unindexed,
               case
                 when not l.ok then null                                  -- failed: never required
                 when l.sig = any(exempt) then null                       -- invokes no watched program
                 when e.signature is null then 'UNINDEXED_SIGNATURE'
                 when e.decoded is not true then 'UNDECODED_SIGNATURE'
                 when e.slot is null then 'UNPROVEN_EVENT_SLOT'           -- refreshed without minContextSlot
                 when e.slot <> l.slot then 'SLOT_MISMATCH'
               end as kind
          from listed l
          left join public.indexer_events e on e.network = p_network and e.signature = l.sig  -- unique (network, signature)
         where l.slot > fl
      ), first_gap as (
        select kind, slot from judged where kind is not null order by slot, sig limit 1
      )
      select (select g.kind from first_gap g),
             (select max(j.slot) from judged j where not exists (select 1 from first_gap g where j.slot >= g.slot)),
             array(select j.sig from judged j where j.unindexed and j.slot <= p_tip_slot - settle order by j.slot, j.sig limit 2),
             coalesce((select bool_or(j.kind = 'UNINDEXED_SIGNATURE' and j.slot <= p_tip_slot - settle) from judged j), false)
        into gap_kind, top, prog_candidates, prog_expire;
      if gap_kind is not null then reason := coalesce(reason, gap_kind); end if;
      candidates := (candidates || prog_candidates)[1:2];
      expire := expire or prog_expire;

      if can_advance then
        new_slot := wm.slot;
        new_resume_sig := wm.resume_signature;
        new_resume_slot := wm.resume_slot;
        if complete then
          if top is not null then
            cap := least(top, p_tip_slot - settle, finalized);
            -- From a cursor, rows of the cursor's own slot may sit above it.
            if resume_mode then cap := least(cap, wm.resume_slot - 1); end if;
            if cap > coalesce(wm.slot, -1) then new_slot := cap; end if;
          end if;
          new_resume_sig := null;
          new_resume_slot := null;
        elsif jsonb_array_length(item->'rows') > 0 then
          -- Not down to the floor: continue below the oldest row next run.
          new_resume_sig := item->'rows'->-1->>'signature';
          new_resume_slot := (item->'rows'->-1->>'slot')::bigint;
        elsif resume_mode then
          -- The node does not know the cursor: start again from the tip.
          new_resume_sig := null;
          new_resume_slot := null;
        end if;
        if new_slot is distinct from wm.slot or new_resume_sig is distinct from wm.resume_signature
           or new_resume_slot is distinct from wm.resume_slot then
          insert into public.indexer_heartbeat_watermarks(network, program, slot, resume_signature, resume_slot, updated_at)
            values (p_network, prog, new_slot, new_resume_sig, new_resume_slot, now_ts)
          on conflict (network, program) do update
            set slot = greatest(indexer_heartbeat_watermarks.slot, excluded.slot),
                resume_signature = excluded.resume_signature, resume_slot = excluded.resume_slot,
                updated_at = excluded.updated_at;
        end if;
      end if;
    end loop;

    -- S1: the sampled mirrored accounts against the finalized chain. A mirror
    -- row newer than the snapshot, closed or gone is not compared.
    for acct in select value from jsonb_array_elements(p_sample->'accounts') loop
      select * into ver from public.indexer_account_versions where network = p_network and pda = acct->>'pda';
      if not found or ver.closed or ver.table_name is null or not (ver.table_name = any(mirror_tables)) then
        continue;
      end if;
      execute format('select raw->>''base64'', last_slot from public.%I where network = $1 and pda = $2', ver.table_name)
        into m_data, m_slot using p_network, acct->>'pda';
      get diagnostics n = row_count;
      if n = 0 or m_slot > finalized then continue; end if;
      if jsonb_typeof(acct->'data') is distinct from 'string'
         or (acct->>'owner') is distinct from programs[1]
         or m_data is null or (acct->>'data') is distinct from m_data then
        sample_ok := false;
        exit;
      end if;
    end loop;
    if not sample_ok then
      reason := coalesce(reason, 'SAMPLE_MISMATCH');                     -- the cursor stays: re-checked next run
    elsif cardinality(hb.sample_pdas) > 0 then
      new_cursor := hb.sample_pdas[cardinality(hb.sample_pdas)];
    end if;
  end if;

  -- P7 and the verdict. The only writes to indexer_sync_state: checked_at.
  if reason is null and hb.mode = 'off' then reason := 'OFF'; end if;
  if reason is null and hb.mode = 'on' then
    update public.indexer_sync_state set checked_at = greatest(checked_at, hb.planned_at)
     where network = p_network and status = 'ready' and completed_at is not null;
    outcome := 'bumped';
  elsif reason is null then
    outcome := 'would_bump';
  else
    outcome := 'declined';
  end if;
  if expire and hb.mode = 'on' then
    update public.indexer_sync_state set checked_at = now_ts - interval '5 minutes 1 second'
     where network = p_network and status = 'ready' and checked_at > now_ts - interval '5 minutes 1 second';
    expired := found;
  end if;
  update public.indexer_heartbeat_state set
    plan_id = null,
    tip_slot = case when store_tip then p_tip_slot else tip_slot end,
    tip_seen_at = case when store_tip then hb.planned_at else tip_seen_at end,
    sample_cursor = coalesce(new_cursor, sample_cursor),
    probe_signatures = case when evidence then candidates else probe_signatures end,
    last_attempt_at = now_ts,
    last_outcome = outcome,
    last_reason = reason,
    last_proven_at = case when reason is null then hb.planned_at else last_proven_at end,
    last_expired_at = case when expired then now_ts else last_expired_at end,
    declined_since = case when reason is null then null else coalesce(declined_since, now_ts) end,
    updated_at = now_ts
   where network = p_network;
  return jsonb_build_object('outcome', outcome, 'reason', reason, 'expired', expired,
    'checked_at', case when outcome = 'bumped' then hb.planned_at end);
end;
$$;

-- ── 5. Grants ─────────────────────────────────────────────────────────────
revoke all on function
  public.indexer_heartbeat_programs(),
  public.indexer_heartbeat_plan(text),
  public.confirm_indexer_quiet(text, uuid, text, bigint, jsonb, jsonb, text[])
  from public, anon, authenticated;
grant execute on function
  public.indexer_heartbeat_programs(),
  public.indexer_heartbeat_plan(text),
  public.confirm_indexer_quiet(text, uuid, text, bigint, jsonb, jsonb, text[])
  to service_role;

select mancipatio_ops.install_network_guards();

notify pgrst, 'reload schema';

commit;
