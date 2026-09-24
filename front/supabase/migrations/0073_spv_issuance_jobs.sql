-- 0073 (Talas 5.1): the EUR 3M ledger driven by the indexer.
--
-- EXPAND step: every 0066 function keeps its signature, so the front that is
-- live when this is applied keeps working (0074 is the contract step).
--
--   spv_issuances_sale_once   one source='sale' issuance per (SPV, sale):
--                             a legacy duplicate is linked, never inserted
--   spv_issuance_jobs         one job per closed sale (trigger on the sales
--                             mirror, plus a backfill) or per mint_to_treasury
--                             transaction (the alarm worker); processed by the
--                             retry worker's ledger stage
--   sale_capacity_holds       an on-chain fact the ledger could not count (no
--                             EUR rate: ADOPTION_PENDING) or counted at a
--                             stale rate (FX_REVALUE) blocks NEW reservations
--                             and manual rows of that subject until fixed
--   issue dates               a booked sale counts from its proven close date
--                             (booked_issued_at; never in the future)
--   server bookings           never refused (the chain already acted): over
--                             the cap they are recorded and flagged over_cap
--                             (enforce_spv_annual_cap v2 lets sale and
--                             treasury_mint rows through; manual rows keep a
--                             rolling 12-month check)
--   adopt_treasury_mint       a mint nobody reserved is counted at the floor
--                             value; revalue_treasury_mint lets the super admin
--                             raise it (never below the floor)
--   revalue_capacity_fx       raises any value counted at a stale rate once a
--                             fresh one exists; never lowers one
--   record_spv_adjustment     the manual path: a reason code, a note, and it
--                             can never name a sale (REF_IS_SALE)
--
-- Every new table and function is service_role only. New network columns
-- default to public.deployment_network() and are guarded (0071 rules).
--
-- Rollback (not a migration): drop trigger sales_enqueue_close_job on
-- public.sales; drop trigger sale_capacity_hold_guard on
-- public.sale_capacity_reservations; then re-apply 0066_sale_capacity.sql and
-- 0027_spv_cap_trigger.sql (both are re-runnable and restore the previous
-- function bodies). Keep spv_issuances_sale_once and the new tables.
--
-- Re-runnable. Re-applying it after 0074 recreates record_spv_issuance;
-- re-apply 0074 afterwards.
begin;
set local lock_timeout = '15s';

-- ── 1. Preflight ──────────────────────────────────────────────────────────
-- Manual rows that may duplicate a sale are listed by
-- scripts/ops/ledger-preflight.sql (read-only) and do not block this file.
do $$
declare dup text;
begin
  select string_agg(format('%s/%s (%s rows)', spv_id, sale_pubkey, n), ', ') into dup
  from (select spv_id, sale_pubkey, count(*) n from public.spv_issuances
         where source = 'sale' and sale_pubkey is not null group by 1, 2 having count(*) > 1) d;
  if dup is not null then
    raise exception 'SPV_SALE_DUPLICATES %', dup
      using hint = 'Run scripts/ops/ledger-preflight.sql and merge the duplicate sale rows before 0073.';
  end if;
end;
$$;

-- ── 2. Uniqueness ─────────────────────────────────────────────────────────
create unique index if not exists spv_issuances_sale_once
  on public.spv_issuances(spv_id, sale_pubkey) where source = 'sale' and sale_pubkey is not null;

-- ── 3. Columns ────────────────────────────────────────────────────────────
alter table public.sale_capacity_reservations add column if not exists booked_issued_at date;
alter table public.spv_issuances add column if not exists reason_code text;
alter table public.spv_issuances drop constraint if exists spv_issuances_reason_code_check;
alter table public.spv_issuances add constraint spv_issuances_reason_code_check
  check (reason_code is null or reason_code in ('off_platform_issuance', 'correction', 'legacy_import'));
comment on column public.sale_capacity_reservations.booked_issued_at is
  'The date a booked row counts from in the rolling window: the proven on-chain close (or mint) date, never in the future (0073).';

-- ── 4. spv_issuance_jobs ──────────────────────────────────────────────────
create table if not exists public.spv_issuance_jobs (
  id uuid primary key default gen_random_uuid(),
  network text not null default public.deployment_network()
    check (network in ('devnet', 'mainnet', 'testnet', 'localnet')),
  kind text not null check (kind in ('sale_close', 'treasury_mint')),
  -- The sale PDA, or the mint transaction signature.
  ref text not null check (ref ~ '^[1-9A-HJ-NP-Za-km-z]{32,96}$'),
  share_class_pda text check (share_class_pda is null or share_class_pda ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  observed_signature text check (observed_signature is null or observed_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$'),
  observed_slot bigint,
  closed_at timestamptz,
  closed_signature text check (closed_signature is null or closed_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$'),
  issued_at_source text check (issued_at_source in ('chain', 'observed')),
  spv_id uuid references public.spvs(id) on delete set null,
  subject text check (subject is null or subject ~ '^(spv|issuer):'),
  reservation_id uuid references public.sale_capacity_reservations(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'complete', 'invalid')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error text check (last_error is null or last_error ~ '^[A-Z_]{1,40}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (network, kind, ref)
);
create index if not exists spv_issuance_jobs_due_idx
  on public.spv_issuance_jobs(network, next_attempt_at) where status = 'pending';
alter table public.spv_issuance_jobs enable row level security;
revoke all on public.spv_issuance_jobs from public, anon, authenticated;
grant all on public.spv_issuance_jobs to service_role;
drop trigger if exists spv_issuance_jobs_touch on public.spv_issuance_jobs;
create trigger spv_issuance_jobs_touch before update on public.spv_issuance_jobs
  for each row execute function public.touch_updated_at();

-- ── 5. sales (indexer mirror) → sale_close jobs ───────────────────────────
-- Fires inside apply_indexer_snapshot; stale snapshots were already dropped
-- by the BEFORE trigger (0047), so a closed sale is enqueued once.
create or replace function public.sales_enqueue_close_job()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from 1 or new.sale_approval is null
     or new.pda !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    if old.status is not distinct from 1 then return null; end if;
  end if;
  begin
    insert into public.spv_issuance_jobs(network, kind, ref, share_class_pda, observed_signature, observed_slot)
    values (new.network, 'sale_close', new.pda,
      case when new.share_class_pda ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' then new.share_class_pda end,
      case when new.last_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$' then new.last_signature end,
      new.last_slot)
    on conflict (network, kind, ref) do nothing;
  end;
  return null;
end;
$$;
revoke all on function public.sales_enqueue_close_job() from public, anon, authenticated, service_role;
drop trigger if exists sales_enqueue_close_job on public.sales;
create trigger sales_enqueue_close_job
  after insert or update on public.sales
  for each row execute function public.sales_enqueue_close_job();

-- ── 6. Backfill: every closed approved sale (covered ones complete at once) ─
insert into public.spv_issuance_jobs(network, kind, ref, share_class_pda, observed_signature, observed_slot)
select s.network, 'sale_close', s.pda,
  case when s.share_class_pda ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' then s.share_class_pda end,
  case when s.last_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$' then s.last_signature end,
  s.last_slot
from public.sales s
where s.status = 1 and s.sale_approval is not null and s.pda ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
on conflict (network, kind, ref) do nothing;

-- ── 7. Capacity holds ─────────────────────────────────────────────────────
create table if not exists public.sale_capacity_holds (
  network text not null default public.deployment_network()
    check (network in ('devnet', 'mainnet', 'testnet', 'localnet')),
  subject text not null check (subject ~ '^(spv|issuer):'),
  -- ADOPTION_PENDING: the sale PDA or the mint key; FX_REVALUE: the reservation id.
  ref text not null check (length(ref) between 1 and 120),
  code text not null check (code in ('ADOPTION_PENDING', 'FX_REVALUE')),
  payment_mint text check (payment_mint is null or payment_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  created_at timestamptz not null default now(),
  primary key (network, subject, ref)
);
alter table public.sale_capacity_holds enable row level security;
revoke all on public.sale_capacity_holds from public, anon, authenticated;
grant all on public.sale_capacity_holds to service_role;

create or replace function public.place_capacity_hold(
  p_network text, p_subject text, p_ref text, p_code text, p_payment_mint text default null
) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare placed integer;
begin
  if p_subject is null or p_subject !~ '^(spv|issuer):' or p_ref is null or p_code not in ('ADOPTION_PENDING', 'FX_REVALUE') then
    raise exception 'INVALID_HOLD' using errcode = 'P0001';
  end if;
  insert into public.sale_capacity_holds(network, subject, ref, code, payment_mint)
  values (p_network, p_subject, p_ref, p_code, p_payment_mint)
  on conflict (network, subject, ref) do nothing;
  get diagnostics placed = row_count;
  return placed = 1;
end;
$$;

create or replace function public.clear_capacity_hold(p_network text, p_subject text, p_ref text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare cleared integer;
begin
  delete from public.sale_capacity_holds where network = p_network and subject = p_subject and ref = p_ref;
  get diagnostics cleared = row_count;
  return cleared > 0;
end;
$$;

-- New reservations of a held subject are refused. Adoptions and chain
-- bookings (adopted = true) always pass: the chain already acted. Runs inside
-- reserve_* after the subject lock, so it is serialized with every writer.
create or replace function public.sale_capacity_hold_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.sale_capacity_holds h where h.network = new.network and h.subject = new.subject) then
    raise exception 'SUBJECT_ON_HOLD' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.sale_capacity_hold_guard() from public, anon, authenticated, service_role;
drop trigger if exists sale_capacity_hold_guard on public.sale_capacity_reservations;
create trigger sale_capacity_hold_guard
  before insert on public.sale_capacity_reservations
  for each row when (not new.adopted)
  execute function public.sale_capacity_hold_guard();

-- ── 8. The treasury floor (0066 reserve_treasury_mint_capacity's rule) ────
-- At least EUR 1; otherwise the units at the newest indexed sale price, else
-- at the newest approval's minimum price, at the fx_rates rate (any age).
-- fx_missing: a price exists but its mint has no rate (the floor is then
-- only EUR 1, which the caller must not accept silently).
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
    select * into fx from public.fx_rates where network = p_network and payment_mint = ref_mint;
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

-- ── 9. book_sale_reservation v2 ───────────────────────────────────────────
create or replace function public.book_sale_reservation(p_id uuid, p_gross_base_units numeric, p_issued_at date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.sale_capacity_reservations%rowtype; booked numeric; issuance bigint; failure text;
  issued date; existing public.spv_issuances%rowtype; linked boolean := false; cap jsonb;
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
  -- The proven close date (the ledger job), else today; never in the future.
  issued := least(coalesce(p_issued_at,
      (select (coalesce(j.closed_at, j.created_at) at time zone 'UTC')::date from public.spv_issuance_jobs j
        where j.network = r.network and j.kind = 'sale_close' and j.ref = r.sale_pda),
      current_date), current_date);
  booked := public.sale_capacity_eur(p_gross_base_units, r.fx_rate, r.payment_decimals);
  if r.spv_id is not null then
    begin
      insert into public.spv_issuances(spv_id, asset_pda, sale_pubkey, amount_eur, issued_at, note, recorded_by, source)
      values (r.spv_id, r.asset_pda, r.sale_pda, booked, issued,
        format('Sale %s closed: %s base units of %s at %s EUR/token (%s, %s); reservation %s',
          r.sale_id, p_gross_base_units, r.payment_mint, r.fx_rate, r.fx_kind, r.fx_source, r.id),
        'server', 'sale')
      returning id into issuance;
    exception
      when unique_violation then
        -- A legacy row already counts this sale: link it, never a second row.
        select * into existing from public.spv_issuances
         where spv_id = r.spv_id and sale_pubkey = r.sale_pda and source = 'sale';
        if not found then
          failure := sqlerrm;
        else
          linked := true;
          issuance := existing.id;
        end if;
      when others then
        failure := sqlerrm;
    end;
    if failure is not null then
      update public.sale_capacity_reservations set last_error = left(failure, 2000) where id = p_id returning * into r;
      return to_jsonb(r) || jsonb_build_object('book_error', failure);
    end if;
  end if;
  update public.sale_capacity_reservations
     set status = 'booked', booked_amount_eur = booked, booked_issuance_id = issuance, booked_at = now(),
         booked_issued_at = issued, last_error = null
   where id = p_id and status = 'consumed'
  returning * into r;
  cap := public.sale_capacity(r.network, r.subject);
  return to_jsonb(r) || jsonb_build_object('over_cap', (cap->>'used')::numeric > (cap->>'cap')::numeric)
    || case when linked then jsonb_build_object('linked_existing', true, 'linked_amount_eur', existing.amount_eur,
         'amount_mismatch', existing.amount_eur <> booked) else '{}'::jsonb end;
end $$;

-- ── 10. book_treasury_mint v2 ─────────────────────────────────────────────
create or replace function public.book_treasury_mint(p_id uuid, p_signature text, p_issued_at date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.sale_capacity_reservations%rowtype; issuance bigint; failure text; issued date; cap jsonb;
begin
  select * into r from public.sale_capacity_reservations where id = p_id and kind = 'treasury_mint';
  if not found then raise exception 'RESERVATION_NOT_FOUND' using errcode = 'P0001'; end if;
  if p_signature is null or length(p_signature) = 0 then raise exception 'INVALID_SIGNATURE' using errcode = 'P0001'; end if;
  perform public.sale_capacity_lock(r.network, r.spv_id, r.issuer_pda);
  select * into r from public.sale_capacity_reservations where id = p_id for update;
  if r.status = 'booked' then
    if r.mint_signature is distinct from p_signature then raise exception 'RESERVATION_ALREADY_BOOKED' using errcode = 'P0001'; end if;
    return to_jsonb(r);
  end if;
  if exists (select 1 from public.sale_capacity_reservations x
              where x.network = r.network and x.mint_signature = p_signature and x.id <> p_id) then
    raise exception 'MINT_ALREADY_BOOKED' using errcode = 'P0001';
  end if;
  if r.status = 'released' then
    update public.sale_capacity_reservations
       set status = 'reserved', released_at = null, release_reason = null, adopted = true,
           adopted_from = coalesce(adopted_from, jsonb_build_object('status', 'released',
             'release_reason', r.release_reason, 'released_at', r.released_at)),
           last_error = left(format('Treasury mint %s landed although its reservation was released (%s): reactivated',
             p_signature, r.release_reason), 2000)
     where id = p_id
    returning * into r;
  end if;
  if r.status <> 'reserved' then raise exception 'RESERVATION_NOT_LIVE' using errcode = 'P0001'; end if;
  issued := least(coalesce(p_issued_at, current_date), current_date);
  if r.spv_id is not null then
    begin
      insert into public.spv_issuances(spv_id, asset_pda, amount_eur, issued_at, note, recorded_by, source)
      values (r.spv_id, r.asset_pda, r.amount_eur, issued,
        format('Treasury mint of %s units (tx %s): %s; reservation %s', r.amount_units, p_signature, r.reason, r.id),
        'server', 'treasury_mint')
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
     set status = 'booked', mint_signature = p_signature, booked_amount_eur = amount_eur,
         booked_issuance_id = issuance, booked_at = now(), booked_issued_at = issued, chain_confirmed_at = now(),
         last_error = case when adopted then last_error end
   where id = p_id and status = 'reserved'
  returning * into r;
  cap := public.sale_capacity(r.network, r.subject);
  return to_jsonb(r) || jsonb_build_object('over_cap', (cap->>'used')::numeric > (cap->>'cap')::numeric);
end $$;

-- ── 11. adopt_treasury_mint (a mint nobody reserved) ──────────────────────
create or replace function public.adopt_treasury_mint(
  p_network text, p_share_class_pda text, p_asset_pda text, p_issuer_pda text, p_spv_id uuid,
  p_amount_units numeric, p_mint_key text, p_authority text, p_issued_at date, p_snapshot jsonb, p_hash text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  subject text; r public.sale_capacity_reservations%rowtype; f jsonb; amount numeric; issuance bigint; cap jsonb;
  issued date := least(coalesce(p_issued_at, current_date), current_date);
begin
  if p_network is null or p_network not in ('devnet', 'mainnet', 'testnet', 'localnet') then
    raise exception 'INVALID_NETWORK' using errcode = 'P0001';
  end if;
  if p_amount_units is null or p_amount_units <= 0 or p_amount_units > 18446744073709551615
     or p_mint_key is null or p_mint_key !~ '^[1-9A-HJ-NP-Za-km-z]{64,96}(:[0-9]{1,4})?$'
     or p_authority is null or p_share_class_pda is null or p_issuer_pda is null
     or p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' or p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_TERMS' using errcode = 'P0001';
  end if;
  subject := public.sale_capacity_lock(p_network, p_spv_id, p_issuer_pda);
  select * into r from public.sale_capacity_reservations where network = p_network and mint_signature = p_mint_key;
  if found then
    cap := public.sale_capacity(p_network, r.subject);
    return to_jsonb(r) || jsonb_build_object('action', 'existing', 'over_cap', (cap->>'used')::numeric > (cap->>'cap')::numeric);
  end if;
  f := public.treasury_mint_floor(p_network, p_share_class_pda, p_amount_units);
  if (f->>'fx_missing')::boolean then raise exception 'FX_RATE_MISSING' using errcode = 'P0001'; end if;
  amount := (f->>'floor_eur')::numeric;
  insert into public.sale_capacity_reservations(network, kind, share_class_pda, asset_pda, issuer_pda, spv_id, subject,
    application_snapshot, application_hash, amount_units, amount_eur, fx_kind, reason, status, adopted, adopted_from,
    mint_signature, booked_amount_eur, booked_at, booked_issued_at, chain_confirmed_at, reserved_by, last_error)
  values (p_network, 'treasury_mint', p_share_class_pda, p_asset_pda, p_issuer_pda, p_spv_id, subject,
    p_snapshot, p_hash, p_amount_units, amount, 'declared',
    format('Adopted unreserved treasury mint (floor, basis %s)', f->>'basis'), 'booked', true,
    jsonb_build_object('kind', 'unreserved_treasury_mint', 'basis', f->>'basis', 'floor_eur', amount,
      'fx_stale', (f->>'fx_stale')::boolean, 'payment_mint', f->>'payment_mint'),
    p_mint_key, amount, now(), issued, now(), p_authority,
    left(format('Adopted an unreserved treasury mint %s at the floor value', p_mint_key), 2000))
  returning * into r;
  if p_spv_id is not null then
    insert into public.spv_issuances(spv_id, asset_pda, amount_eur, issued_at, note, recorded_by, source)
    values (p_spv_id, p_asset_pda, amount, issued,
      format('Unreserved treasury mint of %s units (%s), adopted at the floor (basis %s); reservation %s',
        p_amount_units, p_mint_key, f->>'basis', r.id),
      'server', 'treasury_mint')
    returning id into issuance;
    update public.sale_capacity_reservations set booked_issuance_id = issuance where id = r.id returning * into r;
  end if;
  cap := public.sale_capacity(p_network, subject);
  return to_jsonb(r) || jsonb_build_object('action', 'adopted', 'amount_eur', amount, 'basis', f->>'basis',
    'fx_stale', (f->>'fx_stale')::boolean, 'payment_mint', f->>'payment_mint',
    'over_cap', (cap->>'used')::numeric > (cap->>'cap')::numeric);
end $$;

-- ── 12. revalue_treasury_mint (super admin, via a route) ──────────────────
-- Only rows adopt_treasury_mint wrote (adopted_from.kind
-- 'unreserved_treasury_mint'); never below the floor.
create or replace function public.revalue_treasury_mint(p_id uuid, p_amount_eur numeric, p_reason text, p_by text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.sale_capacity_reservations%rowtype; f jsonb; amount numeric := ceil(p_amount_eur * 100) / 100;
  cap jsonb; old_amount numeric;
begin
  select * into r from public.sale_capacity_reservations where id = p_id;
  if not found then raise exception 'RESERVATION_NOT_FOUND' using errcode = 'P0001'; end if;
  perform public.sale_capacity_lock(r.network, r.spv_id, r.issuer_pda);
  select * into r from public.sale_capacity_reservations where id = p_id for update;
  -- Only a mint the ledger adopted at its floor: a reactivated reservation
  -- (book_treasury_mint also sets adopted) carries the admin's declared value.
  if r.kind <> 'treasury_mint' or r.status <> 'booked' or not r.adopted
     or r.adopted_from->>'kind' is distinct from 'unreserved_treasury_mint' then
    raise exception 'REVALUE_NOT_ALLOWED' using errcode = 'P0001';
  end if;
  if amount is null or amount <= 0 or p_reason is null or length(trim(p_reason)) < 10 or p_by is null then
    raise exception 'INVALID_TERMS' using errcode = 'P0001';
  end if;
  f := public.treasury_mint_floor(r.network, r.share_class_pda, r.amount_units);
  if amount < (f->>'floor_eur')::numeric then
    raise exception 'TREASURY_VALUE_BELOW_FLOOR floor=%', f->>'floor_eur' using errcode = 'P0001';
  end if;
  old_amount := r.amount_eur;
  update public.sale_capacity_reservations
     set amount_eur = amount, booked_amount_eur = amount,
         adopted_from = jsonb_set(coalesce(adopted_from, '{}'::jsonb), '{revaluations}',
           coalesce(adopted_from->'revaluations', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
             'from', old_amount, 'to', amount, 'by', p_by, 'at', now(), 'reason', left(trim(p_reason), 500))))
   where id = p_id
  returning * into r;
  if r.booked_issuance_id is not null then
    update public.spv_issuances set amount_eur = amount where id = r.booked_issuance_id;
  end if;
  cap := public.sale_capacity(r.network, r.subject);
  return to_jsonb(r) || jsonb_build_object('previous_amount_eur', old_amount,
    'over_cap', (cap->>'used')::numeric > (cap->>'cap')::numeric);
end $$;

-- ── 13. revalue_capacity_fx (never lowers a value) ────────────────────────
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
    select * into fx from public.fx_rates where network = r.network and payment_mint = r.payment_mint;
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

-- ── 14. sale_capacity v2 (issuers count from booked_issued_at; holds) ─────
create or replace function public.sale_capacity(p_network text, p_subject text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  cap numeric; cap_source text; issued numeric := 0; reserved numeric := 0; spv uuid; holds integer := 0;
  window_start timestamptz := now() - interval '12 months';
  issuer text; authority text; wallets text[] := array[]::text[]; o_cap numeric;
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
    select coalesce(sum(amount_eur), 0) into issued from public.spv_issuances
     where spv_id = spv and issued_at > (current_date - interval '12 months');
  elsif p_subject ~ '^issuer:[1-9A-HJ-NP-Za-km-z]{32,44}$' then
    select annual_raise_cap_eur into cap from public.platform_raise_limits where network = p_network;
    cap := coalesce(cap, 3000000);
    cap_source := 'platform';
    issuer := substr(p_subject, 8);
    select i.authority into authority from public.issuers i where i.pda = issuer and i.network = p_network;
    if authority is not null then wallets := public.applicant_wallets(authority, p_network); end if;
    select max(l.annual_raise_cap_eur) into o_cap
      from public.client_raise_limits l join public.clients c on c.id = l.client_id
     where c.network = p_network and (c.issuer_pda = issuer or c.wallet = any(wallets));
    if o_cap is not null then cap := o_cap; cap_source := 'client'; end if;
    select coalesce(sum(booked_amount_eur), 0) into issued from public.sale_capacity_reservations
     where network = p_network and subject = p_subject and status = 'booked'
       and coalesce(booked_issued_at, booked_at::date) > (current_date - interval '12 months');
  else
    raise exception 'INVALID_SUBJECT' using errcode = 'P0001';
  end if;
  select coalesce(sum(amount_eur), 0) into reserved from public.sale_capacity_reservations
   where network = p_network and subject = p_subject and status in ('reserved','consumed');
  select count(*) into holds from public.sale_capacity_holds where network = p_network and subject = p_subject;
  return jsonb_build_object('cap', cap, 'issued', issued, 'reserved', reserved, 'used', issued + reserved,
    'remaining', greatest(cap - issued - reserved, 0), 'window_start', window_start, 'cap_source', cap_source,
    'subject', p_subject, 'holds', holds);
end $$;

-- ── 15/16. Manual SPV rows ────────────────────────────────────────────────
-- Shared checks: a manual row never names a sale, and a held subject takes
-- none without the super admin's override.
create or replace function public.spv_manual_row_checks(p_network text, p_spv_id uuid, p_asset_pda text, p_sale_pubkey text, p_cap_override boolean)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if nullif(trim(coalesce(p_sale_pubkey, '')), '') is not null then
    raise exception 'SALE_PUBKEY_NOT_ALLOWED' using errcode = 'P0001';
  end if;
  if nullif(trim(coalesce(p_asset_pda, '')), '') is not null and (
       exists (select 1 from public.sales s where s.network = p_network and s.pda = trim(p_asset_pda))
       or exists (select 1 from public.sale_capacity_reservations x where x.network = p_network and x.sale_pda = trim(p_asset_pda))
       or exists (select 1 from public.spv_issuances i where i.source = 'sale' and i.sale_pubkey = trim(p_asset_pda))) then
    raise exception 'REF_IS_SALE' using errcode = 'P0001';
  end if;
  if not coalesce(p_cap_override, false) and exists (
       select 1 from public.sale_capacity_holds h where h.network = p_network and h.subject = 'spv:' || p_spv_id::text) then
    raise exception 'SUBJECT_ON_HOLD' using errcode = 'P0001';
  end if;
end $$;

-- v2 (compatibility for the front live while 0073 is applied; dropped by 0074).
create or replace function public.record_spv_issuance(
  p_spv_id uuid, p_amount_eur numeric, p_asset_pda text, p_sale_pubkey text, p_issued_at date, p_note text,
  p_recorded_by text, p_cap_override boolean, p_allow_backdate boolean
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare net text; cap jsonb; amount numeric := round(p_amount_eur, 2); issued date := coalesce(p_issued_at, current_date);
  rec public.spv_issuances%rowtype;
begin
  select network into net from public.spvs where id = p_spv_id;
  if not found then raise exception 'SPV_NOT_FOUND' using errcode = 'P0001'; end if;
  if amount is null or amount <= 0 or p_recorded_by is null then raise exception 'INVALID_TERMS' using errcode = 'P0001'; end if;
  if issued > current_date then raise exception 'ISSUED_AT_IN_FUTURE' using errcode = 'P0001'; end if;
  if issued < current_date - 30 and not coalesce(p_allow_backdate, false) then
    raise exception 'ISSUED_AT_BACKDATED' using errcode = 'P0001';
  end if;
  perform public.sale_capacity_lock(net, p_spv_id, null);
  perform public.spv_manual_row_checks(net, p_spv_id, p_asset_pda, p_sale_pubkey, p_cap_override);
  if not coalesce(p_cap_override, false) and issued > current_date - interval '12 months' then
    cap := public.sale_capacity(net, 'spv:' || p_spv_id::text);
    if (cap->>'used')::numeric + amount > (cap->>'cap')::numeric then
      raise exception 'SALE_CAP_EXCEEDED remaining=% cap=% window_start=%', cap->>'remaining', cap->>'cap', cap->>'window_start'
        using errcode = 'P0001';
    end if;
  end if;
  insert into public.spv_issuances(spv_id, amount_eur, asset_pda, sale_pubkey, issued_at, note, recorded_by, source, cap_override)
  values (p_spv_id, amount, nullif(trim(p_asset_pda), ''), null, issued, nullif(p_note, ''), p_recorded_by,
    'manual', coalesce(p_cap_override, false))
  returning * into rec;
  return to_jsonb(rec) || jsonb_build_object('capacity', public.sale_capacity(net, 'spv:' || p_spv_id::text));
end $$;

-- The manual path from 0073 on: an off-chain adjustment with a reason code
-- and a note; the same lock, window and backdate rules as 0066.
create or replace function public.record_spv_adjustment(
  p_spv_id uuid, p_amount_eur numeric, p_asset_pda text, p_issued_at date, p_reason_code text, p_note text,
  p_recorded_by text, p_cap_override boolean, p_allow_backdate boolean
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare net text; cap jsonb; amount numeric := round(p_amount_eur, 2); issued date := coalesce(p_issued_at, current_date);
  rec public.spv_issuances%rowtype;
begin
  select network into net from public.spvs where id = p_spv_id;
  if not found then raise exception 'SPV_NOT_FOUND' using errcode = 'P0001'; end if;
  if amount is null or amount <= 0 or p_recorded_by is null
     or p_reason_code is null or p_reason_code not in ('off_platform_issuance', 'correction', 'legacy_import')
     or p_note is null or length(trim(p_note)) < 10 or length(p_note) > 2000 then
    raise exception 'INVALID_TERMS' using errcode = 'P0001';
  end if;
  if issued > current_date then raise exception 'ISSUED_AT_IN_FUTURE' using errcode = 'P0001'; end if;
  if issued < current_date - 30 and not coalesce(p_allow_backdate, false) then
    raise exception 'ISSUED_AT_BACKDATED' using errcode = 'P0001';
  end if;
  perform public.sale_capacity_lock(net, p_spv_id, null);
  perform public.spv_manual_row_checks(net, p_spv_id, p_asset_pda, null, p_cap_override);
  if not coalesce(p_cap_override, false) and issued > current_date - interval '12 months' then
    cap := public.sale_capacity(net, 'spv:' || p_spv_id::text);
    if (cap->>'used')::numeric + amount > (cap->>'cap')::numeric then
      raise exception 'SALE_CAP_EXCEEDED remaining=% cap=% window_start=%', cap->>'remaining', cap->>'cap', cap->>'window_start'
        using errcode = 'P0001';
    end if;
  end if;
  insert into public.spv_issuances(spv_id, amount_eur, asset_pda, sale_pubkey, issued_at, note, recorded_by, source,
    cap_override, reason_code)
  values (p_spv_id, amount, nullif(trim(p_asset_pda), ''), null, issued, trim(p_note), p_recorded_by, 'manual',
    coalesce(p_cap_override, false), p_reason_code)
  returning * into rec;
  return to_jsonb(rec) || jsonb_build_object('capacity', public.sale_capacity(net, 'spv:' || p_spv_id::text));
end $$;

-- ── 17. enforce_spv_annual_cap v2 (replaces 0027) ─────────────────────────
-- Server bookings (sale, treasury_mint) are never refused: the chain already
-- acted, and the ledger flags them over_cap instead (D12). Manual rows keep a
-- cap check, now over the rolling 12 months ending today, under the same
-- spvs row lock. The message keeps its prefix (the admin route matches it).
create or replace function public.enforce_spv_annual_cap()
returns trigger
language plpgsql
as $$
declare
  cap numeric(18, 2);
  window_total numeric(18, 2);
begin
  if new.source in ('sale', 'treasury_mint') or new.cap_override then
    return new;
  end if;
  select annual_cap_eur into cap from public.spvs where id = new.spv_id for update;
  if cap is null then
    return new;
  end if;
  if new.issued_at <= current_date - interval '12 months' then
    return new; -- outside the window: counts against nothing today
  end if;
  select coalesce(sum(amount_eur), 0) into window_total
  from public.spv_issuances
  where spv_id = new.spv_id
    and issued_at > current_date - interval '12 months';
  if window_total + new.amount_eur > cap then
    raise exception
      'SPV annual issuance cap exceeded: % already issued in the 12 months to %, adding % would exceed the cap of % EUR. Use cap_override to record anyway.',
      window_total, current_date, new.amount_eur, cap;
  end if;
  return new;
end;
$$;

-- ── 18. Grants ────────────────────────────────────────────────────────────
revoke all on function
  public.place_capacity_hold(text, text, text, text, text),
  public.clear_capacity_hold(text, text, text),
  public.treasury_mint_floor(text, text, numeric),
  public.adopt_treasury_mint(text, text, text, text, uuid, numeric, text, text, date, jsonb, text),
  public.revalue_treasury_mint(uuid, numeric, text, text),
  public.revalue_capacity_fx(uuid),
  public.spv_manual_row_checks(text, uuid, text, text, boolean),
  public.record_spv_adjustment(uuid, numeric, text, date, text, text, text, boolean, boolean),
  public.book_sale_reservation(uuid, numeric, date),
  public.book_treasury_mint(uuid, text, date),
  public.sale_capacity(text, text),
  public.record_spv_issuance(uuid, numeric, text, text, date, text, text, boolean, boolean)
  from public, anon, authenticated;
grant execute on function
  public.place_capacity_hold(text, text, text, text, text),
  public.clear_capacity_hold(text, text, text),
  public.treasury_mint_floor(text, text, numeric),
  public.adopt_treasury_mint(text, text, text, text, uuid, numeric, text, text, date, jsonb, text),
  public.revalue_treasury_mint(uuid, numeric, text, text),
  public.revalue_capacity_fx(uuid),
  public.record_spv_adjustment(uuid, numeric, text, date, text, text, text, boolean, boolean),
  public.book_sale_reservation(uuid, numeric, date),
  public.book_treasury_mint(uuid, text, date),
  public.sale_capacity(text, text),
  public.record_spv_issuance(uuid, numeric, text, text, date, text, text, boolean, boolean)
  to service_role;

select mancipatio_ops.install_network_guards();

notify pgrst, 'reload schema';

commit;
