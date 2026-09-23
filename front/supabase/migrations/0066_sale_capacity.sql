-- 0066: EUR 3M capacity reservations for on-chain sale approvals (program
-- package 2B).
--
-- An Admin's `approve_sale` bounds a sale's maximum gross raise on-chain; the
-- EUR value of that bound is RESERVED here, under a per-subject lock, before
-- the approval transaction is sent. The reservation counts against the
-- subject's rolling 12-month cap until it is released (revoked, expired,
-- transaction failed) or booked (the sale closed: the locked-rate EUR value
-- of what was actually sold).
--
--   subject       'spv:<spvs.id>'   when the asset is issued through an SPV
--                 'issuer:<pda>'    otherwise (no asset_profiles.spv_id)
--   cap           spvs.annual_cap_eur, or platform_raise_limits for issuers
--   window        rolling 12 months ending now (stricter than the calendar
--                 year of 0027 / 0056: every calendar year then also stays
--                 under the cap). The 0027 trigger itself is unchanged.
--   used          booked issuances in the window
--                   SPV:    spv_issuances.amount_eur (booked rows land there)
--                   issuer: sale_capacity_reservations.booked_amount_eur
--               + live reservations (status reserved / consumed)
--
-- Admin-issuer treasury mints (`mint_to_treasury` into the issuer's own
-- account, Admin issuer keys only since 2B) are counted the same way, as
-- kind = 'treasury_mint' reservations with a declared EUR value.
--
-- Lock order: every writer here takes the advisory lock
-- 'sale-cap:<network>:<subject>' FIRST, then (SPV subjects) the spvs row
-- FOR UPDATE — the row lock the 0027 trigger takes. The 0027 manual path
-- takes only the row lock, so no cycle is possible.
--
-- Service role only: RLS on, every browser role revoked, functions
-- executable by service_role. Re-runnable (if not exists / or replace).
begin;
set local lock_timeout = '15s';

create table if not exists public.fx_rates (
  network text not null check (network in ('devnet','mainnet','testnet','localnet')),
  payment_mint text not null check (payment_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  kind text not null check (kind in ('eur_peg','rate')),
  eur_per_token numeric(20,10) not null check (eur_per_token > 0),
  decimals smallint not null check (decimals between 0 and 18),
  source text not null check (length(source) between 1 and 200),
  as_of timestamptz not null default now(),
  max_age interval not null default interval '7 days' check (max_age > interval '0 seconds'),
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (network, payment_mint),
  -- An EUR stablecoin is pegged 1:1 by definition.
  constraint fx_rates_peg_is_one check (kind <> 'eur_peg' or eur_per_token = 1)
);
comment on table public.fx_rates is
  'EUR value of one whole payment-mint token per network. eur_peg rows never go stale; rate rows are refused once as_of is older than max_age.';

create table if not exists public.sale_capacity_reservations (
  id uuid primary key default gen_random_uuid(),
  network text not null check (network in ('devnet','mainnet','testnet','localnet')),
  kind text not null check (kind in ('sale','treasury_mint')),
  share_class_pda text not null check (share_class_pda ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  sale_id numeric(20,0) check (sale_id between 0 and 18446744073709551615),
  approval_pda text check (approval_pda ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  sale_pda text check (sale_pda ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  asset_pda text check (asset_pda ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  issuer_pda text not null check (issuer_pda ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  spv_id uuid references public.spvs(id) on delete restrict,
  subject text not null check (subject ~ '^(spv|issuer):'),
  -- Null only for a super-admin manual approval (the snapshot carries the reason).
  application_id uuid references public.launch_applications(id) on delete restrict,
  -- The exact input of application_hash, so anyone can recompute it.
  application_snapshot jsonb not null check (jsonb_typeof(application_snapshot) = 'object'),
  application_hash text not null check (application_hash ~ '^[0-9a-f]{64}$'),
  -- Copy of the on-chain SaleApproval terms (base units of the payment mint).
  payment_mint text check (payment_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  payment_decimals smallint check (payment_decimals between 0 and 18),
  max_gross_raise numeric(20,0) check (max_gross_raise > 0 and max_gross_raise <= 18446744073709551615),
  min_price_per_unit numeric(20,0) check (min_price_per_unit > 0),
  max_price_per_unit numeric(20,0) check (max_price_per_unit >= min_price_per_unit and max_price_per_unit <= 18446744073709551615),
  raise_type text check (raise_type in ('mature','startup')),
  -- The approved payout schedule (0/0 for mature; startup vesting > cliff).
  cliff_months smallint check (cliff_months between 0 and 255),
  vesting_months smallint check (vesting_months between 0 and 255),
  expires_at timestamptz,
  -- treasury_mint: share-class units minted.
  amount_units numeric(20,0) check (amount_units > 0 and amount_units <= 18446744073709551615),
  -- Counted value, rounded UP to cents. Consumption may shrink it, never grow it.
  amount_eur numeric(18,2) not null check (amount_eur > 0),
  -- The FX rate locked at reservation; booking uses it, never a newer one.
  fx_rate numeric(20,10) check (fx_rate > 0),
  fx_kind text check (fx_kind in ('eur_peg','rate','declared')),
  fx_source text,
  fx_as_of timestamptz,
  reason text check (length(reason) <= 1000),
  status text not null default 'reserved' check (status in ('reserved','consumed','booked','released')),
  chain_confirmed_at timestamptz,
  approve_signature text,
  mint_signature text,
  consumed_at timestamptz,
  booked_amount_eur numeric(18,2) check (booked_amount_eur >= 0),
  booked_issuance_id bigint references public.spv_issuances(id) on delete restrict,
  booked_at timestamptz,
  released_at timestamptz,
  release_reason text check (release_reason in ('revoked','expired','tx_failed','closed_unsold','admin')),
  last_error text check (length(last_error) <= 2000),
  -- Set when the ledger had to follow the chain instead of the reservation:
  -- an approval with other terms, one nobody reserved, a released one that
  -- landed anyway, or a sale larger than its reservation (adopted_from keeps
  -- the replaced terms). Always raised as a compliance alert.
  adopted boolean not null default false,
  adopted_from jsonb,
  reserved_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sale_capacity_subject_matches check (
    subject = case when spv_id is not null then 'spv:' || spv_id::text else 'issuer:' || issuer_pda end),
  constraint sale_capacity_sale_terms check (kind <> 'sale' or (
    sale_id is not null and approval_pda is not null and sale_pda is not null and payment_mint is not null
    and payment_decimals is not null and max_gross_raise is not null and min_price_per_unit is not null
    and max_price_per_unit is not null and raise_type is not null and expires_at is not null
    and cliff_months is not null and vesting_months is not null
    and fx_rate is not null and fx_kind in ('eur_peg','rate'))),
  constraint sale_capacity_treasury_terms check (kind <> 'treasury_mint' or (
    amount_units is not null and reason is not null and length(reason) > 0 and fx_kind = 'declared')),
  constraint sale_capacity_status_fields check (
    (status <> 'consumed' or (kind = 'sale' and consumed_at is not null))
    and (status <> 'booked' or (booked_at is not null and booked_amount_eur is not null))
    and (status <> 'released' or (released_at is not null and release_reason is not null)))
);
comment on table public.sale_capacity_reservations is
  'EUR raise-cap reservations: one per admin sale approval (kind sale) or admin-issuer treasury mint (kind treasury_mint). reserved and consumed rows count against the subject''s rolling 12-month cap; booked rows count through spv_issuances (SPV subjects) or booked_amount_eur (issuer subjects).';

-- One live reservation per (network, share_class, sale_id); a revoked one can
-- be re-approved.
create unique index if not exists sale_capacity_live_sale_once
  on public.sale_capacity_reservations(network, share_class_pda, sale_id)
  where kind = 'sale' and status in ('reserved','consumed');
-- A sale is booked at most once (an approval can only be used for an unused id).
create unique index if not exists sale_capacity_sale_pda_once
  on public.sale_capacity_reservations(network, sale_pda)
  where kind = 'sale' and status in ('reserved','consumed','booked');
create unique index if not exists sale_capacity_mint_signature_once
  on public.sale_capacity_reservations(network, mint_signature)
  where mint_signature is not null;
create index if not exists sale_capacity_subject_idx
  on public.sale_capacity_reservations(network, subject, status);
create index if not exists sale_capacity_status_idx
  on public.sale_capacity_reservations(network, status, updated_at);
create index if not exists sale_capacity_application_idx
  on public.sale_capacity_reservations(application_id);
create index if not exists sale_capacity_approval_idx
  on public.sale_capacity_reservations(network, approval_pda);

drop trigger if exists sale_capacity_reservations_touch on public.sale_capacity_reservations;
create trigger sale_capacity_reservations_touch before update on public.sale_capacity_reservations
  for each row execute function public.touch_updated_at();

alter table public.fx_rates enable row level security;
alter table public.sale_capacity_reservations enable row level security;
revoke all on public.fx_rates, public.sale_capacity_reservations from public, anon, authenticated;
grant all on public.fx_rates, public.sale_capacity_reservations to service_role;

-- EUR value of `p_units` base units at `p_rate` EUR per whole token, rounded
-- UP to cents. Exact numeric arithmetic (never floating point).
create or replace function public.sale_capacity_eur(p_units numeric, p_rate numeric, p_decimals integer)
returns numeric language sql immutable set search_path = '' as $$
  select ceil(p_units * p_rate / power(10::numeric, p_decimals) * 100) / 100
$$;

-- Rolling 12-month capacity of one subject.
create or replace function public.sale_capacity(p_network text, p_subject text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  cap numeric; cap_source text; issued numeric := 0; reserved numeric := 0; spv uuid;
  window_start timestamptz := now() - interval '12 months';
begin
  if p_network is null or p_network not in ('devnet','mainnet','testnet','localnet') then
    raise exception 'INVALID_NETWORK' using errcode = 'P0001';
  end if;
  if p_subject like 'spv:%' then
    begin spv := substr(p_subject, 5)::uuid;
    exception when others then raise exception 'INVALID_SUBJECT' using errcode = 'P0001'; end;
    select annual_cap_eur into cap from public.spvs where id = spv and network = p_network;
    if not found then raise exception 'SPV_NOT_FOUND' using errcode = 'P0001'; end if;
    cap_source := 'spv';
    -- Booked sale / treasury rows are inserted here, so they count once.
    select coalesce(sum(amount_eur), 0) into issued from public.spv_issuances
     where spv_id = spv and issued_at > (current_date - interval '12 months');
  elsif p_subject ~ '^issuer:[1-9A-HJ-NP-Za-km-z]{32,44}$' then
    select annual_raise_cap_eur into cap from public.platform_raise_limits where network = p_network;
    cap := coalesce(cap, 3000000);
    cap_source := 'platform';
    select coalesce(sum(booked_amount_eur), 0) into issued from public.sale_capacity_reservations
     where network = p_network and subject = p_subject and status = 'booked' and booked_at > window_start;
  else
    raise exception 'INVALID_SUBJECT' using errcode = 'P0001';
  end if;
  select coalesce(sum(amount_eur), 0) into reserved from public.sale_capacity_reservations
   where network = p_network and subject = p_subject and status in ('reserved','consumed');
  return jsonb_build_object('cap', cap, 'issued', issued, 'reserved', reserved, 'used', issued + reserved,
    'remaining', greatest(cap - issued - reserved, 0), 'window_start', window_start, 'cap_source', cap_source,
    'subject', p_subject);
end $$;

-- Serializes every capacity writer of one subject (advisory lock first, then
-- the SPV row the 0027 trigger locks). Returns the subject.
create or replace function public.sale_capacity_lock(p_network text, p_spv_id uuid, p_issuer_pda text)
returns text language plpgsql security definer set search_path = '' as $$
declare subject text := case when p_spv_id is not null then 'spv:' || p_spv_id::text else 'issuer:' || p_issuer_pda end;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sale-cap:' || p_network || ':' || subject, 0));
  if p_spv_id is not null then
    perform 1 from public.spvs where id = p_spv_id and network = p_network for update;
    if not found then raise exception 'SPV_NOT_FOUND' using errcode = 'P0001'; end if;
  end if;
  return subject;
end $$;

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

  select * into fx from public.fx_rates where network = p_network and payment_mint = p_payment_mint;
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

-- The approval transaction confirmed on-chain with the reserved terms.
create or replace function public.confirm_sale_reservation(p_id uuid, p_signature text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.sale_capacity_reservations%rowtype;
begin
  select * into r from public.sale_capacity_reservations where id = p_id and kind = 'sale' for update;
  if not found then raise exception 'RESERVATION_NOT_FOUND' using errcode = 'P0001'; end if;
  if r.status not in ('reserved','consumed') then raise exception 'RESERVATION_NOT_LIVE' using errcode = 'P0001'; end if;
  update public.sale_capacity_reservations
     set chain_confirmed_at = coalesce(chain_confirmed_at, now()),
         approve_signature = coalesce(approve_signature, p_signature), last_error = null
   where id = p_id and status in ('reserved','consumed')
  returning * into r;
  return to_jsonb(r);
end $$;

-- The approval was used by open_sale. Counts the sale's actual maximum
-- (price * total, at the locked rate): shrinks the reservation to it, and if
-- the chain allowed MORE than was reserved (an approval with other terms),
-- records reality instead of refusing: grows it and flags it (adopted; the
-- caller raises an alert), even past the cap.
create or replace function public.consume_sale_reservation(p_id uuid, p_sale_pda text, p_sale_gross_max numeric)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.sale_capacity_reservations%rowtype; shrunk numeric; grew boolean := false;
begin
  select * into r from public.sale_capacity_reservations where id = p_id and kind = 'sale' for update;
  if not found then raise exception 'RESERVATION_NOT_FOUND' using errcode = 'P0001'; end if;
  if r.sale_pda is distinct from p_sale_pda then raise exception 'SALE_MISMATCH' using errcode = 'P0001'; end if;
  if r.status in ('consumed','booked') then return to_jsonb(r); end if;
  if r.status <> 'reserved' then raise exception 'RESERVATION_NOT_LIVE' using errcode = 'P0001'; end if;
  if p_sale_gross_max is null or p_sale_gross_max <= 0 or p_sale_gross_max > 18446744073709551615 then
    raise exception 'INVALID_GROSS' using errcode = 'P0001';
  end if;
  if p_sale_gross_max > r.max_gross_raise then
    grew := true;
    perform public.sale_capacity_lock(r.network, r.spv_id, r.issuer_pda);
    update public.sale_capacity_reservations
       set status = 'consumed', consumed_at = now(), chain_confirmed_at = coalesce(chain_confirmed_at, now()),
           adopted = true,
           adopted_from = coalesce(adopted_from, jsonb_build_object('max_gross_raise', max_gross_raise::text, 'amount_eur', amount_eur)),
           max_gross_raise = p_sale_gross_max,
           amount_eur = greatest(amount_eur, public.sale_capacity_eur(p_sale_gross_max, fx_rate, payment_decimals)),
           last_error = left(format('The sale (gross %s) is larger than its reservation (%s): counted at the sale''s size',
             p_sale_gross_max, max_gross_raise), 2000)
     where id = p_id and status = 'reserved'
    returning * into r;
  else
    shrunk := least(r.amount_eur, public.sale_capacity_eur(p_sale_gross_max, r.fx_rate, r.payment_decimals));
    update public.sale_capacity_reservations
       set status = 'consumed', consumed_at = now(), amount_eur = shrunk,
           chain_confirmed_at = coalesce(chain_confirmed_at, now()), last_error = null
     where id = p_id and status = 'reserved'
    returning * into r;
  end if;
  return to_jsonb(r) || jsonb_build_object('grew', grew,
    'capacity', public.sale_capacity(r.network, r.subject));
end $$;

-- The sale closed: book what was actually sold at the locked rate. An SPV
-- subject gets an spv_issuances row (source 'sale'; the 0027 trigger still
-- runs — if it refuses, the row stays consumed with last_error set).
create or replace function public.book_sale_reservation(p_id uuid, p_gross_base_units numeric, p_issued_at date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.sale_capacity_reservations%rowtype; booked numeric; issuance bigint; failure text;
begin
  select * into r from public.sale_capacity_reservations where id = p_id and kind = 'sale';
  if not found then raise exception 'RESERVATION_NOT_FOUND' using errcode = 'P0001'; end if;
  perform public.sale_capacity_lock(r.network, r.spv_id, r.issuer_pda);
  select * into r from public.sale_capacity_reservations where id = p_id for update;
  if r.status = 'booked' or (r.status = 'released' and r.release_reason = 'closed_unsold') then return to_jsonb(r); end if;
  if r.status <> 'consumed' then raise exception 'RESERVATION_NOT_CONSUMED' using errcode = 'P0001'; end if;
  if p_gross_base_units is null or p_gross_base_units < 0 or p_gross_base_units > r.max_gross_raise then
    raise exception 'INVALID_GROSS' using errcode = 'P0001';
  end if;
  if p_gross_base_units = 0 then
    update public.sale_capacity_reservations
       set status = 'released', release_reason = 'closed_unsold', released_at = now(), booked_amount_eur = 0, last_error = null
     where id = p_id and status = 'consumed'
    returning * into r;
    return to_jsonb(r);
  end if;
  booked := public.sale_capacity_eur(p_gross_base_units, r.fx_rate, r.payment_decimals);
  if r.spv_id is not null then
    begin
      insert into public.spv_issuances(spv_id, asset_pda, sale_pubkey, amount_eur, issued_at, note, recorded_by, source)
      values (r.spv_id, r.asset_pda, r.sale_pda, booked, coalesce(p_issued_at, current_date),
        format('Sale %s closed: %s base units of %s at %s EUR/token (%s, %s); reservation %s',
          r.sale_id, p_gross_base_units, r.payment_mint, r.fx_rate, r.fx_kind, r.fx_source, r.id),
        'server', 'sale')
      returning id into issuance;
    exception when others then
      failure := sqlerrm;
    end;
    if failure is not null then
      update public.sale_capacity_reservations set last_error = left(failure, 2000) where id = p_id returning * into r;
      return to_jsonb(r) || jsonb_build_object('book_error', failure);
    end if;
  end if;
  update public.sale_capacity_reservations
     set status = 'booked', booked_amount_eur = booked, booked_issuance_id = issuance, booked_at = now(), last_error = null
   where id = p_id and status = 'consumed'
  returning * into r;
  return to_jsonb(r);
end $$;

-- Releases an unused reservation (never a consumed or booked one).
create or replace function public.release_sale_reservation(p_id uuid, p_reason text, p_by text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.sale_capacity_reservations%rowtype;
begin
  if p_reason is null or p_reason not in ('revoked','expired','tx_failed','admin') then
    raise exception 'INVALID_RELEASE_REASON' using errcode = 'P0001';
  end if;
  select * into r from public.sale_capacity_reservations where id = p_id for update;
  if not found then raise exception 'RESERVATION_NOT_FOUND' using errcode = 'P0001'; end if;
  if r.status = 'released' then return to_jsonb(r); end if;
  if r.status <> 'reserved' then raise exception 'RESERVATION_NOT_RELEASABLE' using errcode = 'P0001'; end if;
  update public.sale_capacity_reservations
     set status = 'released', release_reason = p_reason, released_at = now(),
         last_error = case when p_by is null then last_error else left('released by ' || p_by, 2000) end
   where id = p_id and status = 'reserved'
  returning * into r;
  return to_jsonb(r);
end $$;

-- The chain is the truth: an on-chain SaleApproval whose terms differ from
-- its live reservation, that no live reservation covers (approved directly on
-- the program, or its reservation was released while the transaction was
-- still in flight), is ADOPTED so it is counted at its on-chain terms, past
-- the cap if need be. Never refuses for capacity; the caller raises a
-- compliance alert. Returns the row plus `action` (none | adopted_terms |
-- reactivated | inserted) and `over_cap`.
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
    select * into fx from public.fx_rates where network = p_network and payment_mint = p_payment_mint;
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

-- Admin-issuer treasury mint: reserve its declared EUR value first.
create or replace function public.reserve_treasury_mint_capacity(
  p_network text, p_share_class_pda text, p_asset_pda text, p_issuer_pda text, p_spv_id uuid,
  p_amount_units numeric, p_amount_eur numeric, p_reason text, p_snapshot jsonb, p_hash text, p_reserved_by text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare subject text; cap jsonb; new_id uuid; amount numeric := ceil(p_amount_eur * 100) / 100;
begin
  if p_network is null or p_network not in ('devnet','mainnet','testnet','localnet') then
    raise exception 'INVALID_NETWORK' using errcode = 'P0001';
  end if;
  if p_amount_units is null or p_amount_units <= 0 or amount is null or amount <= 0
     or p_reason is null or length(trim(p_reason)) = 0 or p_reserved_by is null then
    raise exception 'INVALID_TERMS' using errcode = 'P0001';
  end if;
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
  return jsonb_build_object('id', new_id, 'amount_eur', amount, 'subject', subject,
    'capacity', public.sale_capacity(p_network, subject));
end $$;

-- The treasury mint confirmed on-chain (the route verified its TreasuryMinted
-- evidence): book it. SPV subjects get an spv_issuances row (source
-- 'treasury_mint').
create or replace function public.book_treasury_mint(p_id uuid, p_signature text, p_issued_at date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.sale_capacity_reservations%rowtype; issuance bigint;
begin
  select * into r from public.sale_capacity_reservations where id = p_id and kind = 'treasury_mint';
  if not found then raise exception 'RESERVATION_NOT_FOUND' using errcode = 'P0001'; end if;
  perform public.sale_capacity_lock(r.network, r.spv_id, r.issuer_pda);
  select * into r from public.sale_capacity_reservations where id = p_id for update;
  if r.status = 'booked' then
    if r.mint_signature is distinct from p_signature then raise exception 'RESERVATION_ALREADY_BOOKED' using errcode = 'P0001'; end if;
    return to_jsonb(r);
  end if;
  if r.status <> 'reserved' then raise exception 'RESERVATION_NOT_LIVE' using errcode = 'P0001'; end if;
  if r.spv_id is not null then
    insert into public.spv_issuances(spv_id, asset_pda, amount_eur, issued_at, note, recorded_by, source)
    values (r.spv_id, r.asset_pda, r.amount_eur, coalesce(p_issued_at, current_date),
      format('Treasury mint of %s units (tx %s): %s; reservation %s', r.amount_units, p_signature, r.reason, r.id),
      'server', 'treasury_mint')
    returning id into issuance;
  end if;
  update public.sale_capacity_reservations
     set status = 'booked', mint_signature = p_signature, booked_amount_eur = amount_eur,
         booked_issuance_id = issuance, booked_at = now(), chain_confirmed_at = now(), last_error = null
   where id = p_id and status = 'reserved'
  returning * into r;
  return to_jsonb(r);
end $$;

revoke all on function
  public.sale_capacity_eur(numeric,numeric,integer),
  public.sale_capacity(text,text),
  public.sale_capacity_lock(text,uuid,text),
  public.reserve_sale_capacity(text,text,numeric,text,text,text,text,uuid,uuid,jsonb,text,text,integer,numeric,numeric,numeric,text,timestamptz,text,integer,integer),
  public.adopt_sale_approval(text,text,numeric,text,text,text,text,uuid,text,numeric,numeric,numeric,text,integer,integer,timestamptz,text,text,text),
  public.confirm_sale_reservation(uuid,text),
  public.consume_sale_reservation(uuid,text,numeric),
  public.book_sale_reservation(uuid,numeric,date),
  public.release_sale_reservation(uuid,text,text),
  public.reserve_treasury_mint_capacity(text,text,text,text,uuid,numeric,numeric,text,jsonb,text,text),
  public.book_treasury_mint(uuid,text,date)
  from public, anon, authenticated;
grant execute on function
  public.sale_capacity_eur(numeric,numeric,integer),
  public.sale_capacity(text,text),
  public.reserve_sale_capacity(text,text,numeric,text,text,text,text,uuid,uuid,jsonb,text,text,integer,numeric,numeric,numeric,text,timestamptz,text,integer,integer),
  public.adopt_sale_approval(text,text,numeric,text,text,text,text,uuid,text,numeric,numeric,numeric,text,integer,integer,timestamptz,text,text,text),
  public.confirm_sale_reservation(uuid,text),
  public.consume_sale_reservation(uuid,text,numeric),
  public.book_sale_reservation(uuid,numeric,date),
  public.release_sale_reservation(uuid,text,text),
  public.reserve_treasury_mint_capacity(text,text,text,text,uuid,numeric,numeric,text,jsonb,text,text),
  public.book_treasury_mint(uuid,text,date)
  to service_role;

commit;
