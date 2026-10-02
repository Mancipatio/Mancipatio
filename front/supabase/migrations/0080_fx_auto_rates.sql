-- 0080: the automatic EUR rate of payment mints (owner's request of
-- 2026-10-02: "automatski API za kurs u realnom vremenu").
--
-- Until now the EUR value of USDC was one fx_rates row per (network, mint),
-- entered by the Super Admin on /admin/limits and refused by the ledger once
-- older than its max age (7 days on mainnet, D18). From 0080 a worker
-- (POST /api/internal/fx, every minute, scripts/ops/fx-scheduler.sql) keeps
-- an AUTOMATIC rate next to it: the median of public USDC/EUR order books,
-- refused when the sources disagree by more than 1 % or the median is more
-- than 2 % away from the ECB reference rate (lib/fx-auto.ts). The manual row
-- stays: the fallback while the automatic rate is stale, or a deliberate
-- override.
--
--  1. fx_rates.override_auto (default false): a manual row that wins even
--     over a fresh automatic rate. fx_rates keeps its primary key and every
--     0066 rule; nothing else about it changes.
--  2. fx_auto_rates: the latest ACCEPTED automatic rate per (network, mint),
--     with the per-source quotes and the ECB anchor it was accepted on, and a
--     short max age (15 minutes from the worker).
--  3. fx_rate_observations: every run, accepted or refused (with its code
--     and the quotes): the audit trail, the rate limit and what the alarm
--     worker reads (source down, depeg, divergence, jump). Kept 30 days.
--  4. claim_fx_auto_run(): the rate limit, taken BEFORE any outside
--     request. Serialized per (network, mint); a run is claimed only when
--     neither an observation nor another claim (fx_auto_runs) is younger
--     than 20 seconds, so concurrent calls (a leaked worker secret, a
--     runaway scheduler) get claimed=false and ask no source, and a run
--     whose recording then fails still holds its 20-second slot.
--     record_fx_auto_rate() / record_fx_auto_refusal(): the only writers of
--     the rate and the observations, under the same lock, refusing a second
--     observation within 20 seconds as well.
--  5. fx_effective_rate(network, mint): the rate that counts, as an fx_rates
--     row (lib/fx-effective.ts is the same rule for the TypeScript readers):
--       a manual eur_peg row → it; a manual row with override_auto → it;
--       a fresh automatic rate → it (kind rate, updated_by 'fx-auto');
--       a fresh manual row → it (the fallback);
--       nothing fresh → the most recently observed one (manual on a tie), so
--       FX_RATE_STALE stays the refusal and any-age readers get the best price;
--       neither → no row (FX_RATE_MISSING).
--  6. The five ledger functions that read fx_rates read fx_effective_rate
--     instead: reserve_sale_capacity, adopt_sale_approval,
--     reserve_treasury_mint_capacity (0066), treasury_mint_floor and
--     revalue_capacity_fx (0073). Their bodies are copied unchanged apart
--     from that one statement; a reservation still LOCKS the rate it was
--     made at (fx_rate, fx_kind, fx_source — "auto: median of …" for an
--     automatic one — and fx_as_of), and booking never uses a newer one.
--
-- EXPAND step: backward compatible. Without automatic rows every reader
-- behaves exactly as before (fx_effective_rate returns the manual row), and
-- the previous front keeps working (it never reads the new objects; it does
-- not send override_auto, which defaults to false).
--
-- Network: the new tables default to public.deployment_network() and carry
-- the 0071 guard (rules 1–3). Service role only: RLS on, browser roles
-- revoked; the functions run as their owner and are executable by
-- service_role.
--
-- Off switch (no rollback needed): disable 'mancipatio-fx-<network>' and
-- `delete from public.fx_auto_rates where network = public.deployment_network();`
-- — the manual rows count again at once. Rollback (not a migration): make
-- fx_effective_rate return the manual row only (runbook §15 "Automatic EUR
-- rate"); the tables, the column and the writers can stay.
--
-- Re-runnable: every statement is idempotent. Re-applying 0066 or 0073 (their
-- rollbacks) restores their direct fx_rates reads; re-apply 0080 after them.
begin;
set local lock_timeout = '15s';

do $$
begin
  if to_regclass('public.fx_rates') is null
     or to_regprocedure('public.treasury_mint_floor(text,text,numeric)') is null
     or to_regprocedure('public.revalue_capacity_fx(uuid)') is null
     or to_regprocedure('public.deployment_network()') is null
     or to_regprocedure('mancipatio_ops.install_network_guards()') is null then
    raise exception 'Apply 0066, 0070, 0071 and 0073 before 0080';
  end if;
end;
$$;

-- ── 1. The manual override ────────────────────────────────────────────────
alter table public.fx_rates add column if not exists override_auto boolean not null default false;
comment on column public.fx_rates.override_auto is
  'True: this manual rate counts even while a fresh automatic rate exists (0080). False (default): it is the fallback while the automatic rate is missing or stale.';

-- ── 2. The automatic rate ─────────────────────────────────────────────────
create table if not exists public.fx_auto_rates (
  network text not null default public.deployment_network()
    check (network in ('devnet','mainnet','testnet','localnet')),
  payment_mint text not null check (payment_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  eur_per_token numeric(20,10) not null check (eur_per_token > 0),
  decimals smallint not null check (decimals between 0 and 18),
  -- "auto: median of kraken, coinbase, … (ECB <date>: <USD per EUR> USD/EUR)"
  source text not null check (length(source) between 1 and 200),
  -- The run's evidence: per-source quotes or error codes, the median, the
  -- spread and the ECB anchor with its deviation (public prices only).
  quotes jsonb not null check (jsonb_typeof(quotes) = 'object'),
  as_of timestamptz not null,
  max_age interval not null default interval '15 minutes'
    check (max_age >= interval '1 minute' and max_age <= interval '1 day'),
  updated_at timestamptz not null default now(),
  primary key (network, payment_mint)
);
comment on table public.fx_auto_rates is
  'The latest ACCEPTED automatic EUR rate per payment mint (0080), written only by record_fx_auto_rate(). Used while younger than max_age; fx_effective_rate() decides between it and the manual fx_rates row.';

-- ── 3. Every run ──────────────────────────────────────────────────────────
create table if not exists public.fx_rate_observations (
  id bigint generated always as identity primary key,
  network text not null default public.deployment_network()
    check (network in ('devnet','mainnet','testnet','localnet')),
  payment_mint text not null check (payment_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  observed_at timestamptz not null default now(),
  status text not null check (status in ('accepted','refused')),
  code text check (code is null or code ~ '^[A-Z_]{1,40}$'),
  eur_per_token numeric(20,10) check (eur_per_token is null or eur_per_token > 0),
  quotes jsonb not null default '{}'::jsonb check (jsonb_typeof(quotes) = 'object'),
  constraint fx_rate_observations_outcome check (
    (status = 'accepted' and eur_per_token is not null and code is null)
    or (status = 'refused' and code is not null))
);
create index if not exists fx_rate_observations_mint_idx
  on public.fx_rate_observations(network, payment_mint, observed_at desc);
comment on table public.fx_rate_observations is
  'Every automatic EUR rate run (0080): accepted with its rate, or refused with a code (TOO_FEW_SOURCES, SOURCE_DIVERGENCE, ECB_UNAVAILABLE, ECB_STALE, ECB_DEVIATION, DECIMALS_UNAVAILABLE). Kept 30 days.';

-- The last claimed run per (network, mint): claim_fx_auto_run() only.
create table if not exists public.fx_auto_runs (
  network text not null default public.deployment_network()
    check (network in ('devnet','mainnet','testnet','localnet')),
  payment_mint text not null check (payment_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  claimed_at timestamptz not null default now(),
  primary key (network, payment_mint)
);
comment on table public.fx_auto_runs is
  'The last claimed automatic EUR rate run per payment mint (0080): the rate limit taken before any outside request, written only by claim_fx_auto_run().';

alter table public.fx_auto_rates enable row level security;
alter table public.fx_rate_observations enable row level security;
alter table public.fx_auto_runs enable row level security;
revoke all on public.fx_auto_rates, public.fx_rate_observations, public.fx_auto_runs from public, anon, authenticated;
revoke all on sequence public.fx_rate_observations_id_seq from public, anon, authenticated;
grant all on public.fx_auto_rates, public.fx_rate_observations, public.fx_auto_runs to service_role;

-- ── 4. The claim and the writers ──────────────────────────────────────────
-- Shared checks and the per-(network, mint) lock (held to the end of the
-- calling transaction).
create or replace function public.fx_auto_lock(p_network text, p_payment_mint text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_network is null or p_network not in ('devnet','mainnet','testnet','localnet') then
    raise exception 'INVALID_NETWORK' using errcode = 'P0001';
  end if;
  if p_payment_mint is null or p_payment_mint !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' then
    raise exception 'INVALID_PAYMENT_MINT' using errcode = 'P0001';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('fx-auto:' || p_network || ':' || p_payment_mint, 0));
end $$;

-- The run's slot, before it asks any source: {claimed: true} when neither an
-- observation nor an earlier claim is younger than 20 s; {claimed: false}
-- (ask nothing) otherwise. The claim is not released: a run that fails to
-- record keeps the window closed for the rest of its 20 seconds.
create or replace function public.claim_fx_auto_run(p_network text, p_payment_mint text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare last_at timestamptz; claimed timestamptz;
begin
  perform public.fx_auto_lock(p_network, p_payment_mint);
  select max(observed_at) into last_at from public.fx_rate_observations
   where network = p_network and payment_mint = p_payment_mint;
  select claimed_at into claimed from public.fx_auto_runs
   where network = p_network and payment_mint = p_payment_mint;
  if greatest(last_at, claimed) > now() - interval '20 seconds' then
    return jsonb_build_object('claimed', false);
  end if;
  insert into public.fx_auto_runs as r (network, payment_mint, claimed_at)
  values (p_network, p_payment_mint, now())
  on conflict (network, payment_mint) do update set claimed_at = excluded.claimed_at;
  return jsonb_build_object('claimed', true);
end $$;

-- The writers' rate limit, under the same lock. True when a run may record
-- now; false when the last observation is younger than 20 s. (A run's own
-- claim does not count here: it was taken moments earlier by that run.)
create or replace function public.fx_auto_may_record(p_network text, p_payment_mint text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare last_at timestamptz;
begin
  perform public.fx_auto_lock(p_network, p_payment_mint);
  select max(observed_at) into last_at from public.fx_rate_observations
   where network = p_network and payment_mint = p_payment_mint;
  if last_at is not null and last_at > now() - interval '20 seconds' then return false; end if;
  -- Retention: 30 days, a bounded batch per run.
  delete from public.fx_rate_observations where id in (
    select id from public.fx_rate_observations
     where network = p_network and observed_at < now() - interval '30 days' order by observed_at limit 500);
  return true;
end $$;

create or replace function public.record_fx_auto_rate(
  p_network text, p_payment_mint text, p_eur_per_token numeric, p_decimals integer, p_source text,
  p_quotes jsonb, p_max_age_seconds integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_eur_per_token is null or p_eur_per_token <= 0 or p_decimals is null or p_decimals < 0 or p_decimals > 18
     or p_source is null or length(p_source) not between 1 and 200
     or p_quotes is null or jsonb_typeof(p_quotes) <> 'object'
     or p_max_age_seconds is null or p_max_age_seconds not between 60 and 86400 then
    raise exception 'INVALID_FX_RATE' using errcode = 'P0001';
  end if;
  if not public.fx_auto_may_record(p_network, p_payment_mint) then
    return jsonb_build_object('written', false, 'throttled', true);
  end if;
  insert into public.fx_rate_observations(network, payment_mint, status, eur_per_token, quotes)
  values (p_network, p_payment_mint, 'accepted', p_eur_per_token, p_quotes);
  insert into public.fx_auto_rates as a (network, payment_mint, eur_per_token, decimals, source, quotes, as_of, max_age, updated_at)
  values (p_network, p_payment_mint, p_eur_per_token, p_decimals, p_source, p_quotes, now(),
    make_interval(secs => p_max_age_seconds), now())
  on conflict (network, payment_mint) do update
    set eur_per_token = excluded.eur_per_token, decimals = excluded.decimals, source = excluded.source,
        quotes = excluded.quotes, as_of = excluded.as_of, max_age = excluded.max_age, updated_at = now();
  return jsonb_build_object('written', true, 'throttled', false, 'as_of', now());
end $$;

create or replace function public.record_fx_auto_refusal(
  p_network text, p_payment_mint text, p_code text, p_quotes jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_code is null or p_code !~ '^[A-Z_]{1,40}$' or p_quotes is null or jsonb_typeof(p_quotes) <> 'object' then
    raise exception 'INVALID_FX_REFUSAL' using errcode = 'P0001';
  end if;
  if not public.fx_auto_may_record(p_network, p_payment_mint) then
    return jsonb_build_object('written', false, 'throttled', true);
  end if;
  insert into public.fx_rate_observations(network, payment_mint, status, code, quotes)
  values (p_network, p_payment_mint, 'refused', p_code, p_quotes);
  return jsonb_build_object('written', true, 'throttled', false);
end $$;

-- ── 5. The rate that counts ───────────────────────────────────────────────
create or replace function public.fx_effective_rate(p_network text, p_payment_mint text)
returns setof public.fx_rates language plpgsql stable security definer set search_path = '' as $$
declare
  m public.fx_rates%rowtype; a public.fx_auto_rates%rowtype; auto_row public.fx_rates%rowtype;
  have_m boolean; have_a boolean;
begin
  select * into m from public.fx_rates where network = p_network and payment_mint = p_payment_mint;
  have_m := found;
  select * into a from public.fx_auto_rates where network = p_network and payment_mint = p_payment_mint;
  have_a := found;
  if have_a then
    auto_row.network := a.network;
    auto_row.payment_mint := a.payment_mint;
    auto_row.kind := 'rate';
    auto_row.eur_per_token := a.eur_per_token;
    auto_row.decimals := a.decimals;
    auto_row.source := a.source;
    auto_row.as_of := a.as_of;
    auto_row.max_age := a.max_age;
    auto_row.updated_by := 'fx-auto';
    auto_row.updated_at := a.updated_at;
    auto_row.override_auto := false;
  end if;
  if have_m and (m.kind = 'eur_peg' or m.override_auto) then return next m; return; end if;
  if have_a and a.as_of >= now() - a.max_age then return next auto_row; return; end if;
  if have_m and m.as_of >= now() - m.max_age then return next m; return; end if;
  if have_a and (not have_m or a.as_of > m.as_of) then return next auto_row; return; end if;
  if have_m then return next m; end if;
  return;
end $$;
comment on function public.fx_effective_rate(text, text) is
  'The EUR rate that counts for a payment mint (0080): manual eur_peg or override_auto, else a fresh automatic rate, else a fresh manual one, else the most recently observed one. lib/fx-effective.ts mirrors it.';

revoke all on function public.fx_auto_lock(text, text) from public, anon, authenticated, service_role;
revoke all on function public.fx_auto_may_record(text, text) from public, anon, authenticated, service_role;
revoke all on function public.claim_fx_auto_run(text, text) from public, anon, authenticated;
grant execute on function public.claim_fx_auto_run(text, text) to service_role;
revoke all on function public.record_fx_auto_rate(text, text, numeric, integer, text, jsonb, integer) from public, anon, authenticated;
revoke all on function public.record_fx_auto_refusal(text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.fx_effective_rate(text, text) from public, anon, authenticated;
grant execute on function public.record_fx_auto_rate(text, text, numeric, integer, text, jsonb, integer) to service_role;
grant execute on function public.record_fx_auto_refusal(text, text, text, jsonb) to service_role;
grant execute on function public.fx_effective_rate(text, text) to service_role;

-- ── 6. The ledger reads the effective rate ────────────────────────────────
-- reserve_sale_capacity (0066_sale_capacity.sql; only its fx_rates read changed)
create or replace function public.reserve_sale_capacity(
  p_network text, p_share_class_pda text, p_sale_id numeric, p_approval_pda text, p_sale_pda text,
  p_asset_pda text, p_issuer_pda text, p_spv_id uuid, p_application_id uuid, p_application_snapshot jsonb,
  p_application_hash text, p_payment_mint text, p_payment_decimals integer, p_max_gross_raise numeric,
  p_min_price_per_unit numeric, p_max_price_per_unit numeric, p_raise_type text, p_expires_at timestamptz,
  p_reserved_by text, p_cliff_months integer, p_vesting_months integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  subject text; fx public.fx_rates%rowtype; existing public.sale_capacity_reservations%rowtype;
  app public.launch_applications%rowtype; amount numeric; cap jsonb; new_id uuid;
begin
  if p_network is null or p_network not in ('devnet','mainnet','testnet','localnet') then
    raise exception 'INVALID_NETWORK' using errcode = 'P0001';
  end if;
  if p_max_gross_raise is null or p_max_gross_raise <= 0 or p_min_price_per_unit is null or p_min_price_per_unit <= 0
     or p_max_price_per_unit is null or p_max_price_per_unit < p_min_price_per_unit or p_expires_at is null
     or p_expires_at <= now() or p_raise_type not in ('mature','startup') or p_reserved_by is null
     or p_cliff_months is null or p_vesting_months is null or p_cliff_months < 0 or p_vesting_months > 255
     or (p_raise_type = 'mature' and (p_cliff_months <> 0 or p_vesting_months <> 0))
     or (p_raise_type = 'startup' and p_vesting_months <= p_cliff_months) then
    raise exception 'INVALID_TERMS' using errcode = 'P0001';
  end if;
  perform public.sale_capacity_check_subject(p_network, p_asset_pda, p_issuer_pda, p_spv_id);
  subject := public.sale_capacity_lock(p_network, p_spv_id, p_issuer_pda);

  -- Idempotent retry of the same request; anything else for a live id refuses.
  select * into existing from public.sale_capacity_reservations
   where network = p_network and kind = 'sale' and share_class_pda = p_share_class_pda
     and sale_id = p_sale_id and status in ('reserved','consumed')
   for update;
  if found then
    if existing.status = 'reserved' and existing.chain_confirmed_at is null
       and existing.approval_pda = p_approval_pda and existing.application_hash = p_application_hash
       and existing.payment_mint = p_payment_mint and existing.max_gross_raise = p_max_gross_raise
       and existing.min_price_per_unit = p_min_price_per_unit and existing.max_price_per_unit = p_max_price_per_unit
       and existing.raise_type = p_raise_type and existing.expires_at = p_expires_at
       and existing.cliff_months = p_cliff_months and existing.vesting_months = p_vesting_months
       and existing.reserved_by = p_reserved_by
       and existing.application_id is not distinct from p_application_id then
      return jsonb_build_object('id', existing.id, 'amount_eur', existing.amount_eur, 'subject', existing.subject,
        'existing', true, 'capacity', public.sale_capacity(p_network, subject));
    end if;
    raise exception 'RESERVATION_EXISTS' using errcode = 'P0001';
  end if;

  select * into fx from public.fx_effective_rate(p_network, p_payment_mint);
  if not found then raise exception 'FX_RATE_MISSING' using errcode = 'P0001'; end if;
  if fx.decimals <> p_payment_decimals then raise exception 'FX_DECIMALS_MISMATCH' using errcode = 'P0001'; end if;
  if fx.kind = 'rate' and fx.as_of < now() - fx.max_age then raise exception 'FX_RATE_STALE' using errcode = 'P0001'; end if;
  amount := public.sale_capacity_eur(p_max_gross_raise, fx.eur_per_token, fx.decimals);

  if p_application_id is not null then
    select * into app from public.launch_applications where id = p_application_id for share;
    if not found or app.network <> p_network or app.status <> 'approved' then
      raise exception 'APPLICATION_NOT_APPROVED' using errcode = 'P0001';
    end if;
    if app.raise_type <> p_raise_type then raise exception 'RAISE_TYPE_MISMATCH' using errcode = 'P0001'; end if;
    -- A startup approval carries the reviewed payout schedule exactly.
    if p_raise_type = 'startup' and (app.cliff_months is distinct from p_cliff_months
       or app.vesting_months is distinct from p_vesting_months) then
      raise exception 'SCHEDULE_MISMATCH' using errcode = 'P0001';
    end if;
    -- One application backs one sale (the listing links exactly one): no
    -- second approval while one is live or used, none once a sale is linked.
    if app.linked_sale_pubkey is not null or exists (
      select 1 from public.sale_capacity_reservations x
       where x.application_id = p_application_id and x.kind = 'sale'
         and x.status in ('reserved','consumed','booked')) then
      raise exception 'APPLICATION_ALREADY_APPROVED' using errcode = 'P0001';
    end if;
    if amount > app.raise_amount then
      raise exception 'APPLICATION_AMOUNT_EXCEEDED amount=% raise_amount=%', amount, app.raise_amount using errcode = 'P0001';
    end if;
  end if;

  cap := public.sale_capacity(p_network, subject);
  if (cap->>'used')::numeric + amount > (cap->>'cap')::numeric then
    raise exception 'SALE_CAP_EXCEEDED remaining=% cap=% window_start=%', cap->>'remaining', cap->>'cap', cap->>'window_start'
      using errcode = 'P0001';
  end if;

  insert into public.sale_capacity_reservations(network, kind, share_class_pda, sale_id, approval_pda, sale_pda, asset_pda,
    issuer_pda, spv_id, subject, application_id, application_snapshot, application_hash, payment_mint, payment_decimals,
    max_gross_raise, min_price_per_unit, max_price_per_unit, raise_type, cliff_months, vesting_months, expires_at,
    amount_eur, fx_rate, fx_kind, fx_source, fx_as_of, reserved_by)
  values (p_network, 'sale', p_share_class_pda, p_sale_id, p_approval_pda, p_sale_pda, p_asset_pda, p_issuer_pda, p_spv_id,
    subject, p_application_id, p_application_snapshot, p_application_hash, p_payment_mint, p_payment_decimals,
    p_max_gross_raise, p_min_price_per_unit, p_max_price_per_unit, p_raise_type, p_cliff_months, p_vesting_months,
    p_expires_at, amount, fx.eur_per_token, fx.kind, fx.source, fx.as_of, p_reserved_by)
  returning id into new_id;
  return jsonb_build_object('id', new_id, 'amount_eur', amount, 'subject', subject, 'existing', false,
    'capacity', public.sale_capacity(p_network, subject));
end $$;

-- adopt_sale_approval (0066_sale_capacity.sql; only its fx_rates read changed)
create or replace function public.adopt_sale_approval(
  p_network text, p_share_class_pda text, p_sale_id numeric, p_approval_pda text, p_sale_pda text,
  p_asset_pda text, p_issuer_pda text, p_spv_id uuid, p_payment_mint text,
  p_max_gross_raise numeric, p_min_price_per_unit numeric, p_max_price_per_unit numeric, p_raise_type text,
  p_cliff_months integer, p_vesting_months integer, p_expires_at timestamptz, p_application_hash text,
  p_approved_by text, p_source text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  subject text; r public.sale_capacity_reservations%rowtype; fx public.fx_rates%rowtype; amount numeric;
  action text := 'none'; cap jsonb; old_terms jsonb; same boolean; have_row boolean;
begin
  if p_network is null or p_network not in ('devnet','mainnet','testnet','localnet') then
    raise exception 'INVALID_NETWORK' using errcode = 'P0001';
  end if;
  subject := public.sale_capacity_lock(p_network, p_spv_id, p_issuer_pda);
  -- The newest row of this approval PDA (a PDA is one (share class, sale id)).
  select * into r from public.sale_capacity_reservations
   where network = p_network and kind = 'sale' and approval_pda = p_approval_pda
   order by (status in ('reserved','consumed')) desc, created_at desc limit 1 for update;
  have_row := found;
  if have_row and r.status in ('consumed','booked') then
    return to_jsonb(r) || jsonb_build_object('action', 'none', 'over_cap', false);
  end if;
  if have_row then
    same := r.payment_mint = p_payment_mint and r.max_gross_raise = p_max_gross_raise
      and r.min_price_per_unit = p_min_price_per_unit and r.max_price_per_unit = p_max_price_per_unit
      and r.raise_type = p_raise_type and r.cliff_months = p_cliff_months and r.vesting_months = p_vesting_months
      and r.expires_at = p_expires_at and r.application_hash = p_application_hash and r.reserved_by = p_approved_by;
    if r.status = 'reserved' and same then
      return to_jsonb(r) || jsonb_build_object('action', 'none', 'over_cap', false);
    end if;
  end if;
  if have_row and r.payment_mint = p_payment_mint then
    amount := public.sale_capacity_eur(p_max_gross_raise, r.fx_rate, r.payment_decimals);
  else
    -- Another payment mint (or no row): the current rate, even a stale one.
    select * into fx from public.fx_effective_rate(p_network, p_payment_mint);
    if not found then raise exception 'FX_RATE_MISSING' using errcode = 'P0001'; end if;
    amount := public.sale_capacity_eur(p_max_gross_raise, fx.eur_per_token, fx.decimals);
  end if;
  if have_row then
    old_terms := jsonb_build_object('status', r.status, 'release_reason', r.release_reason, 'payment_mint', r.payment_mint,
      'max_gross_raise', r.max_gross_raise::text, 'min_price_per_unit', r.min_price_per_unit::text,
      'max_price_per_unit', r.max_price_per_unit::text, 'raise_type', r.raise_type, 'cliff_months', r.cliff_months,
      'vesting_months', r.vesting_months, 'expires_at', r.expires_at, 'application_hash', r.application_hash,
      'application_id', r.application_id, 'reserved_by', r.reserved_by, 'amount_eur', r.amount_eur);
    action := case when r.status = 'released' then 'reactivated' else 'adopted_terms' end;
    update public.sale_capacity_reservations
       set status = 'reserved', released_at = null, release_reason = null,
           chain_confirmed_at = coalesce(chain_confirmed_at, now()),
           -- An approval for another application hash is not this application's.
           application_id = case when application_hash = p_application_hash then application_id end,
           payment_decimals = case when payment_mint = p_payment_mint then payment_decimals else fx.decimals end,
           payment_mint = p_payment_mint,
           fx_rate = case when payment_mint = p_payment_mint then fx_rate else fx.eur_per_token end,
           fx_kind = case when payment_mint = p_payment_mint then fx_kind else fx.kind end,
           fx_source = case when payment_mint = p_payment_mint then fx_source else fx.source end,
           fx_as_of = case when payment_mint = p_payment_mint then fx_as_of else fx.as_of end,
           max_gross_raise = p_max_gross_raise, min_price_per_unit = p_min_price_per_unit,
           max_price_per_unit = p_max_price_per_unit, raise_type = p_raise_type, cliff_months = p_cliff_months,
           vesting_months = p_vesting_months, expires_at = p_expires_at, application_hash = p_application_hash,
           reserved_by = p_approved_by,
           amount_eur = greatest(amount, amount_eur),
           adopted = true, adopted_from = coalesce(adopted_from, old_terms),
           last_error = left(format('Adopted the on-chain approval (%s, source %s)', action, p_source), 2000)
     where id = r.id
    returning * into r;
  else
    action := 'inserted';
    insert into public.sale_capacity_reservations(network, kind, share_class_pda, sale_id, approval_pda, sale_pda, asset_pda,
      issuer_pda, spv_id, subject, application_snapshot, application_hash, payment_mint, payment_decimals,
      max_gross_raise, min_price_per_unit, max_price_per_unit, raise_type, cliff_months, vesting_months, expires_at,
      amount_eur, fx_rate, fx_kind, fx_source, fx_as_of, chain_confirmed_at, adopted, last_error, reserved_by)
    values (p_network, 'sale', p_share_class_pda, p_sale_id, p_approval_pda, p_sale_pda, p_asset_pda, p_issuer_pda, p_spv_id,
      subject, jsonb_build_object('v', 1, 'kind', 'adopted', 'source', p_source, 'approval_pda', p_approval_pda),
      p_application_hash, p_payment_mint, fx.decimals, p_max_gross_raise, p_min_price_per_unit,
      p_max_price_per_unit, p_raise_type, p_cliff_months, p_vesting_months, p_expires_at, amount, fx.eur_per_token,
      fx.kind, fx.source, fx.as_of, now(), true,
      left(format('Adopted an on-chain approval nobody reserved (source %s)', p_source), 2000), p_approved_by)
    returning * into r;
  end if;
  cap := public.sale_capacity(p_network, subject);
  return to_jsonb(r) || jsonb_build_object('action', action,
    'over_cap', (cap->>'used')::numeric > (cap->>'cap')::numeric, 'capacity', cap);
end $$;

-- reserve_treasury_mint_capacity (0066_sale_capacity.sql; only its fx_rates read changed)
create or replace function public.reserve_treasury_mint_capacity(
  p_network text, p_share_class_pda text, p_asset_pda text, p_issuer_pda text, p_spv_id uuid,
  p_amount_units numeric, p_amount_eur numeric, p_reason text, p_snapshot jsonb, p_hash text, p_reserved_by text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  subject text; cap jsonb; new_id uuid; amount numeric := ceil(p_amount_eur * 100) / 100;
  ref_price numeric; ref_mint text; fx public.fx_rates%rowtype; floor_eur numeric;
begin
  if p_network is null or p_network not in ('devnet','mainnet','testnet','localnet') then
    raise exception 'INVALID_NETWORK' using errcode = 'P0001';
  end if;
  if p_amount_units is null or p_amount_units <= 0 or p_amount_units > 18446744073709551615 or amount is null or amount <= 0
     or p_reason is null or length(trim(p_reason)) = 0 or p_reserved_by is null then
    raise exception 'INVALID_TERMS' using errcode = 'P0001';
  end if;
  if amount < 1 then raise exception 'TREASURY_VALUE_BELOW_FLOOR floor=1.00' using errcode = 'P0001'; end if;
  select s.price_per_unit, s.payment_mint into ref_price, ref_mint from public.sales s
   where s.network = p_network and s.share_class_pda = p_share_class_pda and s.price_per_unit > 0
   order by s.sale_id desc limit 1;
  if ref_price is null then
    select r.min_price_per_unit, r.payment_mint into ref_price, ref_mint from public.sale_capacity_reservations r
     where r.network = p_network and r.kind = 'sale' and r.share_class_pda = p_share_class_pda
     order by r.created_at desc limit 1;
  end if;
  if ref_price is not null then
    select * into fx from public.fx_effective_rate(p_network, ref_mint);
    if found then
      floor_eur := public.sale_capacity_eur(p_amount_units * ref_price, fx.eur_per_token, fx.decimals);
      if amount < floor_eur then
        raise exception 'TREASURY_VALUE_BELOW_FLOOR floor=%', floor_eur using errcode = 'P0001';
      end if;
    end if;
  end if;
  perform public.sale_capacity_check_subject(p_network, p_asset_pda, p_issuer_pda, p_spv_id);
  subject := public.sale_capacity_lock(p_network, p_spv_id, p_issuer_pda);
  cap := public.sale_capacity(p_network, subject);
  if (cap->>'used')::numeric + amount > (cap->>'cap')::numeric then
    raise exception 'SALE_CAP_EXCEEDED remaining=% cap=% window_start=%', cap->>'remaining', cap->>'cap', cap->>'window_start'
      using errcode = 'P0001';
  end if;
  insert into public.sale_capacity_reservations(network, kind, share_class_pda, asset_pda, issuer_pda, spv_id, subject,
    application_snapshot, application_hash, amount_units, amount_eur, fx_kind, reason, reserved_by)
  values (p_network, 'treasury_mint', p_share_class_pda, p_asset_pda, p_issuer_pda, p_spv_id, subject,
    p_snapshot, p_hash, p_amount_units, amount, 'declared', trim(p_reason), p_reserved_by)
  returning id into new_id;
  return jsonb_build_object('id', new_id, 'amount_eur', amount, 'subject', subject, 'floor_eur', floor_eur,
    'capacity', public.sale_capacity(p_network, subject));
end $$;

-- treasury_mint_floor (0073_spv_issuance_jobs.sql; only its fx_rates read changed)
create or replace function public.treasury_mint_floor(p_network text, p_share_class_pda text, p_amount_units numeric)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  ref_price numeric; ref_mint text; basis text := 'minimum'; fx public.fx_rates%rowtype;
  floor_eur numeric := 1; fx_missing boolean := false; fx_stale boolean := false;
begin
  select s.price_per_unit, s.payment_mint into ref_price, ref_mint from public.sales s
   where s.network = p_network and s.share_class_pda = p_share_class_pda and s.price_per_unit > 0
   order by s.sale_id desc limit 1;
  if ref_price is not null then
    basis := 'sale_price';
  else
    select r.min_price_per_unit, r.payment_mint into ref_price, ref_mint from public.sale_capacity_reservations r
     where r.network = p_network and r.kind = 'sale' and r.share_class_pda = p_share_class_pda
     order by r.created_at desc limit 1;
    if ref_price is not null then basis := 'approval_price'; end if;
  end if;
  if ref_price is not null then
    select * into fx from public.fx_effective_rate(p_network, ref_mint);
    if not found then
      fx_missing := true;
    else
      fx_stale := fx.kind = 'rate' and fx.as_of < now() - fx.max_age;
      floor_eur := greatest(1, public.sale_capacity_eur(p_amount_units * ref_price, fx.eur_per_token, fx.decimals));
    end if;
  end if;
  return jsonb_build_object('floor_eur', floor_eur, 'basis', basis, 'fx_missing', fx_missing, 'fx_stale', fx_stale,
    'payment_mint', ref_mint);
end;
$$;

-- revalue_capacity_fx (0073_spv_issuance_jobs.sql; only its fx_rates read changed)
create or replace function public.revalue_capacity_fx(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.sale_capacity_reservations%rowtype; fx public.fx_rates%rowtype; f jsonb; rate numeric;
  amount numeric; booked numeric; cap jsonb;
begin
  select * into r from public.sale_capacity_reservations where id = p_id;
  if not found then raise exception 'RESERVATION_NOT_FOUND' using errcode = 'P0001'; end if;
  perform public.sale_capacity_lock(r.network, r.spv_id, r.issuer_pda);
  select * into r from public.sale_capacity_reservations where id = p_id for update;
  if not exists (select 1 from public.sale_capacity_holds h where h.network = r.network and h.subject = r.subject
                  and h.ref = r.id::text and h.code = 'FX_REVALUE') then
    raise exception 'NO_REVALUE_HOLD' using errcode = 'P0001';
  end if;
  if r.kind = 'sale' then
    select * into fx from public.fx_effective_rate(r.network, r.payment_mint);
    if not found then raise exception 'FX_RATE_MISSING' using errcode = 'P0001'; end if;
    if fx.kind = 'rate' and fx.as_of < now() - fx.max_age then raise exception 'FX_RATE_STALE' using errcode = 'P0001'; end if;
    if fx.decimals <> r.payment_decimals then raise exception 'FX_DECIMALS_MISMATCH' using errcode = 'P0001'; end if;
    rate := greatest(r.fx_rate, fx.eur_per_token);
    if r.status in ('reserved', 'consumed') then
      amount := greatest(r.amount_eur, public.sale_capacity_eur(r.max_gross_raise, rate, r.payment_decimals));
      update public.sale_capacity_reservations
         set fx_rate = rate, fx_as_of = fx.as_of, amount_eur = amount
       where id = p_id returning * into r;
    elsif r.status = 'booked' and fx.eur_per_token > r.fx_rate then
      booked := ceil(r.booked_amount_eur * fx.eur_per_token / r.fx_rate * 100) / 100;
      update public.sale_capacity_reservations
         set fx_rate = rate, fx_as_of = fx.as_of, booked_amount_eur = greatest(booked_amount_eur, booked)
       where id = p_id returning * into r;
      if r.booked_issuance_id is not null then
        update public.spv_issuances set amount_eur = greatest(amount_eur, r.booked_amount_eur) where id = r.booked_issuance_id;
      end if;
    end if;
  elsif r.kind = 'treasury_mint' and r.adopted and r.status = 'booked'
        and r.adopted_from->>'kind' = 'unreserved_treasury_mint' then
    f := public.treasury_mint_floor(r.network, r.share_class_pda, r.amount_units);
    if (f->>'fx_missing')::boolean then raise exception 'FX_RATE_MISSING' using errcode = 'P0001'; end if;
    if (f->>'fx_stale')::boolean then raise exception 'FX_RATE_STALE' using errcode = 'P0001'; end if;
    amount := greatest(r.amount_eur, (f->>'floor_eur')::numeric);
    update public.sale_capacity_reservations set amount_eur = amount, booked_amount_eur = amount
     where id = p_id returning * into r;
    if r.booked_issuance_id is not null then
      update public.spv_issuances set amount_eur = greatest(amount_eur, amount) where id = r.booked_issuance_id;
    end if;
  end if;
  delete from public.sale_capacity_holds where network = r.network and subject = r.subject and ref = r.id::text
    and code = 'FX_REVALUE';
  cap := public.sale_capacity(r.network, r.subject);
  return jsonb_build_object('revalued', true, 'id', r.id, 'amount_eur', r.amount_eur,
    'booked_amount_eur', r.booked_amount_eur, 'over_cap', (cap->>'used')::numeric > (cap->>'cap')::numeric);
end $$;

select mancipatio_ops.install_network_guards();

commit;
