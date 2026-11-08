-- 0089: the public fee schedule (price list) and the charges booked against it.
--
-- fee_schedule is what Manci publishes: one row per fee kind and network
-- while it is in force (tokenization setup, primary sale, conversion,
-- migration setup, migration per holder, OTC), with who pays, a fixed EUR
-- part, a rate in basis points of a EUR base, an optional minimum and
-- maximum, and the public label and note shown on /pricing and next to the
-- forms where a client sees a price before committing (components/fee-quote).
-- The quote is lib/fees/quote.ts quoteFee: max(min, fixed x quantity +
-- base x rate), capped by max, rounded to cents.
--
-- fee_charges is the ledger of what Manci bills: one row per fee owed for a
-- reference (a conversion request, an application, an asset, a migration or
-- another reference), priced by the server from the published row at the
-- moment the charge is created. Collection is by invoice (off-chain) in this
-- version: a charge is due, then invoiced (with the invoice reference), then
-- paid, or waived with a reason. Nothing here moves tokens or money, and the
-- on-chain Platform.protocol_fee_bps stays unused.
--
-- Nothing is charged until an admin publishes a price, enforced here as well
-- as in the routes:
--   * every fee_schedule row starts as a draft; a draft is published only by
--     publish_fee_schedule (below), and never in the statement that creates it;
--   * a charge can only be created against the PUBLISHED row of its kind on
--     its network, once that row is in effect (effective_from <= now);
--   * a published row cannot be edited, only retired (publishing a new
--     version of a kind retires the old one in the same transaction); a
--     retired row is immutable; only drafts can be deleted;
--   * a charge's kind, price, base, amount, reference and payer never change
--     after it is created, it is never deleted (waive it instead), and its
--     status moves only forward: due -> invoiced -> paid, due|invoiced -> waived.
--
-- 0004's fee_config / fee_waivers are NOT touched: fee_config is the internal
-- register of per-engagement terms (rates and wallet recipient splits, from
-- when an on-chain fee split was planned) and fee_waivers the per-client
-- overrides; both stay admin-only records. fee_schedule is the one public
-- price list, fee_charges what is actually billed.
--
-- PRIVACY / RLS: default deny, like 0084. The browser roles have no grant on
-- either table; the service role reads and writes through signed admin
-- routes (app/api/fees/schedule-*, charge-*), and the public reads the
-- published rows only through GET /api/fees/public and the /pricing page,
-- which select a fixed public projection (no ids, no admin wallets).
--
-- 0071 rules: both `network` columns default to public.deployment_network(),
-- nothing is seeded (the suggested prices are DRAFTS an admin creates from
-- /admin/fees), and the migration ends by installing the network guard.
-- Re-runnable: tables and indexes are created if missing, functions and
-- triggers are replaced.
begin;
set local lock_timeout = '15s';

create table if not exists public.fee_schedule (
  id uuid primary key default gen_random_uuid(),
  network text not null default public.deployment_network()
    check (network in ('mainnet', 'devnet', 'testnet', 'localnet')),
  kind text not null check (kind in (
    'tokenization_setup', 'primary_sale', 'conversion',
    'migration_setup', 'migration_per_holder', 'otc'
  )),
  payer text not null check (payer in ('issuer', 'holder', 'buyer', 'seller')),
  fixed_eur numeric(12, 2) not null default 0 check (fixed_eur >= 0),
  rate_bps integer not null default 0 check (rate_bps between 0 and 10000),
  min_eur numeric(12, 2) check (min_eur >= 0),
  max_eur numeric(12, 2) check (max_eur >= 0),
  collection text not null default 'invoice' check (collection in ('invoice')),
  public_label text not null check (length(btrim(public_label)) between 1 and 120),
  public_note text not null default '' check (length(public_note) <= 500),
  status text not null default 'draft' check (status in ('draft', 'published', 'retired')),
  -- When the fee applies. A draft may carry a planned date; publishing never
  -- leaves it in the past (fee_schedule_guard).
  effective_from timestamptz,
  published_at timestamptz,
  published_by text check (published_by is null or length(published_by) between 1 and 64),
  retired_at timestamptz,
  retired_by text check (retired_by is null or length(retired_by) between 1 and 64),
  created_by text not null check (length(created_by) between 1 and 64),
  updated_by text check (updated_by is null or length(updated_by) between 1 and 64),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (min_eur is null or max_eur is null or min_eur <= max_eur),
  -- A published or retired row records when it took effect and who published it.
  check (status = 'draft' or (effective_from is not null and published_at is not null and published_by is not null)),
  check (status <> 'retired' or (retired_at is not null and retired_by is not null))
);
-- One price in force per kind and network.
create unique index if not exists fee_schedule_one_published
  on public.fee_schedule (network, kind) where status = 'published';
create index if not exists fee_schedule_network_idx
  on public.fee_schedule (network, kind, created_at desc);
alter table public.fee_schedule enable row level security;
revoke all on public.fee_schedule from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.fee_schedule to service_role;

-- Lifecycle guard (defense in depth under the routes). The database, not a
-- serverless clock, stamps published_at / retired_at and a strictly
-- increasing updated_at, which the routes compare on every write
-- (compare-and-swap, as 0084).
--   insert            -> draft only
--   draft             -> draft (edit) | published (only inside publish_fee_schedule)
--   published         -> retired (nothing else may change)
--   retired           -> immutable
--   delete            -> drafts only
create or replace function public.fee_schedule_guard()
returns trigger language plpgsql set search_path = '' as $$
declare
  now_ts timestamptz := pg_catalog.clock_timestamp();
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'A fee starts as a draft; publish it separately' using errcode = '23514';
    end if;
    new.published_at := null;
    new.published_by := null;
    new.retired_at := null;
    new.retired_by := null;
    new.created_at := now_ts;
    new.updated_at := now_ts;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Only a draft fee can be deleted; retire a published fee instead' using errcode = '23514';
    end if;
    return old;
  end if;

  if new.id <> old.id or new.network <> old.network then
    raise exception 'A fee''s identity is immutable' using errcode = '23514';
  end if;
  new.created_at := old.created_at;
  new.created_by := old.created_by;
  if old.status = 'draft' then
    if new.status = 'draft' then
      new.published_at := null;
      new.published_by := null;
      new.retired_at := null;
      new.retired_by := null;
    elsif new.status = 'published' then
      -- Only publish_fee_schedule sets this, for the one row it publishes,
      -- for the rest of its transaction; a plain update cannot publish.
      if coalesce(pg_catalog.current_setting('mancipatio.fee_publish', true), '') <> new.id::text then
        raise exception 'Publish a fee with publish_fee_schedule' using errcode = '23514';
      end if;
      if new.published_by is null then
        raise exception 'Publishing a fee records who published it' using errcode = '23514';
      end if;
      new.published_at := now_ts;
      -- A fee never takes effect before it is published.
      new.effective_from := greatest(coalesce(new.effective_from, now_ts), now_ts);
      new.retired_at := null;
      new.retired_by := null;
    else
      raise exception 'illegal fee status transition: % -> %', old.status, new.status using errcode = '23514';
    end if;
  elsif old.status = 'published' then
    if new.status <> 'retired' or
       (new.kind, new.payer, new.fixed_eur, new.rate_bps, new.min_eur, new.max_eur, new.collection,
        new.public_label, new.public_note, new.effective_from, new.published_at, new.published_by)
       is distinct from
       (old.kind, old.payer, old.fixed_eur, old.rate_bps, old.min_eur, old.max_eur, old.collection,
        old.public_label, old.public_note, old.effective_from, old.published_at, old.published_by) then
      raise exception 'A published fee cannot be edited; publish a new version or retire it' using errcode = '23514';
    end if;
    if new.retired_by is null then
      raise exception 'Retiring a fee records who retired it' using errcode = '23514';
    end if;
    new.retired_at := now_ts;
  else
    raise exception 'A retired fee is immutable' using errcode = '23514';
  end if;
  new.updated_at := greatest(now_ts, old.updated_at + interval '1 microsecond');
  return new;
end;
$$;
revoke all on function public.fee_schedule_guard() from public, anon, authenticated, service_role;
drop trigger if exists fee_schedule_guard on public.fee_schedule;
create trigger fee_schedule_guard before insert or update or delete on public.fee_schedule
  for each row execute function public.fee_schedule_guard();

-- Publish one draft: in the same transaction, the price in force for its
-- kind on its network (if any) is retired, so /pricing never shows two
-- prices for one service and never shows a gap between them. The caller's
-- revision must match (compare-and-swap); concurrent publications of one
-- kind are serialized by a transaction lock, and the partial unique index
-- above is the backstop. Returns the published row. Errors:
--   P0002  no such fee on this network
--   P0001  not a draft, or changed since the caller read it
create or replace function public.publish_fee_schedule(
  p_id uuid,
  p_network text,
  p_actor text,
  p_expected_updated_at timestamptz
) returns public.fee_schedule
language plpgsql set search_path = '' as $$
declare
  draft public.fee_schedule;
begin
  if p_id is null or p_network is null or p_expected_updated_at is null or
     p_actor is null or length(p_actor) not between 1 and 64 then
    raise exception 'Invalid fee publication arguments' using errcode = '22023';
  end if;
  select * into draft from public.fee_schedule
    where id = p_id and network = p_network
    for update;
  if not found then
    raise exception 'Fee not found' using errcode = 'P0002';
  end if;
  if draft.status <> 'draft' or draft.updated_at <> p_expected_updated_at then
    raise exception 'This fee changed or is no longer a draft' using errcode = 'P0001';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(1296125507, pg_catalog.hashtext('fee_schedule:' || draft.network || ':' || draft.kind));
  update public.fee_schedule
    set status = 'retired', retired_by = p_actor, updated_by = p_actor
    where network = draft.network and kind = draft.kind and status = 'published';
  perform pg_catalog.set_config('mancipatio.fee_publish', p_id::text, true);
  update public.fee_schedule
    set status = 'published', published_by = p_actor, updated_by = p_actor
    where id = p_id
    returning * into draft;
  perform pg_catalog.set_config('mancipatio.fee_publish', '', true);
  return draft;
end;
$$;
revoke all on function public.publish_fee_schedule(uuid, text, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.publish_fee_schedule(uuid, text, text, timestamptz) to service_role;

create table if not exists public.fee_charges (
  id uuid primary key default gen_random_uuid(),
  network text not null default public.deployment_network()
    check (network in ('mainnet', 'devnet', 'testnet', 'localnet')),
  kind text not null check (kind in (
    'tokenization_setup', 'primary_sale', 'conversion',
    'migration_setup', 'migration_per_holder', 'otc'
  )),
  -- The published price the amount was computed from.
  schedule_id uuid not null references public.fee_schedule(id) on delete restrict,
  payer_client_id uuid references public.clients(id) on delete set null,
  issuer_pda text check (issuer_pda is null or issuer_pda ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  ref_type text not null check (ref_type in ('conversion_request', 'application', 'asset', 'migration', 'other')),
  ref_id text not null check (length(btrim(ref_id)) between 1 and 120),
  -- The EUR base the rate applies to (e.g. the conversion value) and, for a
  -- per-unit fee (migration_per_holder), the number of units.
  base_amount_eur numeric(14, 2) not null default 0 check (base_amount_eur >= 0),
  quantity integer not null default 1 check (quantity between 1 and 1000000),
  amount_eur numeric(12, 2) not null check (amount_eur >= 0),
  status text not null default 'due' check (status in ('due', 'invoiced', 'paid', 'waived')),
  invoice_ref text check (invoice_ref is null or length(btrim(invoice_ref)) between 1 and 120),
  waived_reason text check (waived_reason is null or length(btrim(waived_reason)) between 4 and 500),
  note text not null default '' check (length(note) <= 1000),
  created_by text not null check (length(created_by) between 1 and 64),
  updated_by text check (updated_by is null or length(updated_by) between 1 and 64),
  invoiced_at timestamptz,
  paid_at timestamptz,
  waived_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  -- Which references each kind is billed against (lib/fees/schedule.ts FEE_KIND_REF_TYPES).
  check (
    (ref_type = 'conversion_request' and kind = 'conversion') or
    (ref_type = 'application' and kind in ('tokenization_setup', 'primary_sale')) or
    (ref_type = 'asset' and kind in ('tokenization_setup', 'primary_sale', 'otc')) or
    (ref_type = 'migration' and kind in ('migration_setup', 'migration_per_holder')) or
    ref_type = 'other'
  ),
  check (ref_type not in ('conversion_request', 'application') or
         ref_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  check (ref_type <> 'asset' or ref_id ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  -- Only a per-unit fee multiplies its fixed part.
  check (quantity = 1 or kind = 'migration_per_holder'),
  check (status not in ('invoiced', 'paid') or invoice_ref is not null),
  check (status <> 'waived' or waived_reason is not null)
);
-- One open (not waived) charge per kind and reference: a double submit or a
-- second admin cannot bill the same thing twice.
create unique index if not exists fee_charges_one_per_ref
  on public.fee_charges (network, kind, ref_type, ref_id) where status <> 'waived';
create index if not exists fee_charges_network_idx on public.fee_charges (network, created_at desc);
create index if not exists fee_charges_schedule_idx on public.fee_charges (schedule_id);
create index if not exists fee_charges_payer_idx on public.fee_charges (payer_client_id);
alter table public.fee_charges enable row level security;
revoke all on public.fee_charges from public, anon, authenticated, service_role;
-- No delete grant: a charge is waived, never deleted (the guard refuses it too).
grant select, insert, update on public.fee_charges to service_role;

-- Charge guard (0034 style, defense in depth under the routes).
--   insert   -> due, against the published, in-effect row of its kind and network
--   due      -> invoiced (invoice_ref set) | waived (waived_reason set)
--   invoiced -> paid | waived
--   paid / waived : terminal
-- The amount, its inputs, the reference and the creator never change; the
-- payer can only be cleared, as the clients foreign key's on delete set null
-- does (the routes never send it on an update).
create or replace function public.fee_charges_guard()
returns trigger language plpgsql set search_path = '' as $$
declare
  now_ts timestamptz := pg_catalog.clock_timestamp();
  price record;
begin
  if tg_op = 'DELETE' then
    raise exception 'A fee charge is never deleted; waive it with a reason instead' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'due' then
      raise exception 'A charge starts as due' using errcode = '23514';
    end if;
    select s.network, s.kind, s.status, s.effective_from into price
      from public.fee_schedule s where s.id = new.schedule_id;
    if not found or price.status <> 'published' or price.network <> new.network or price.kind <> new.kind then
      raise exception 'A charge needs the published fee of its kind on its network' using errcode = '23514';
    end if;
    if price.effective_from > now_ts then
      raise exception 'This fee is not in effect yet' using errcode = '23514';
    end if;
    new.invoice_ref := null;
    new.waived_reason := null;
    new.invoiced_at := null;
    new.paid_at := null;
    new.waived_at := null;
    new.created_at := now_ts;
    new.updated_at := now_ts;
    return new;
  end if;

  if (new.id, new.network, new.kind, new.schedule_id, new.issuer_pda, new.ref_type, new.ref_id,
      new.base_amount_eur, new.quantity, new.amount_eur, new.created_by, new.created_at)
     is distinct from
     (old.id, old.network, old.kind, old.schedule_id, old.issuer_pda, old.ref_type, old.ref_id,
      old.base_amount_eur, old.quantity, old.amount_eur, old.created_by, old.created_at) then
    raise exception 'A charge''s amount and reference are immutable' using errcode = '23514';
  end if;
  if new.payer_client_id is distinct from old.payer_client_id and new.payer_client_id is not null then
    raise exception 'A charge''s payer is immutable' using errcode = '23514';
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'due' and new.status in ('invoiced', 'waived')) or
    (old.status = 'invoiced' and new.status in ('paid', 'waived'))
  ) then
    raise exception 'illegal fee charge status transition: % -> %', old.status, new.status using errcode = '23514';
  end if;
  if new.invoice_ref is distinct from old.invoice_ref and not (old.status = 'due' and new.status = 'invoiced') then
    raise exception 'The invoice reference is set when the charge is invoiced' using errcode = '23514';
  end if;
  if new.waived_reason is distinct from old.waived_reason and not (old.status <> 'waived' and new.status = 'waived') then
    raise exception 'The waiver reason is set when the charge is waived' using errcode = '23514';
  end if;
  new.invoiced_at := case when old.status <> 'invoiced' and new.status = 'invoiced' then now_ts else old.invoiced_at end;
  new.paid_at := case when old.status <> 'paid' and new.status = 'paid' then now_ts else old.paid_at end;
  new.waived_at := case when old.status <> 'waived' and new.status = 'waived' then now_ts else old.waived_at end;
  new.updated_at := greatest(now_ts, old.updated_at + interval '1 microsecond');
  return new;
end;
$$;
revoke all on function public.fee_charges_guard() from public, anon, authenticated, service_role;
drop trigger if exists fee_charges_guard on public.fee_charges;
create trigger fee_charges_guard before insert or update or delete on public.fee_charges
  for each row execute function public.fee_charges_guard();

select mancipatio_ops.install_network_guards();

commit;
