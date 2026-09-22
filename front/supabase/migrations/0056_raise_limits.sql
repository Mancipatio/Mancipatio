-- Raise limits for /apply, adjustable by admins as the law changes.
--   platform_raise_limits : per-network defaults (annual cap per applicant per
--                           calendar year, max equity % per application)
--   client_raise_limits   : per-dossier overrides ("case by case")
-- The yearly total counts every live application (pending / needs_changes /
-- approved) of the applicant across ALL wallets linked to the same account,
-- so a second wallet cannot reset the cap. A trigger enforces it under an
-- advisory lock; the routes call raise_capacity() first for a clear message.
begin;

create table public.platform_raise_limits (
  network text primary key check (network in ('devnet','mainnet','testnet','localnet')),
  annual_raise_cap_eur numeric(14,2) not null default 3000000 check (annual_raise_cap_eur > 0),
  max_equity_percent numeric(5,2) not null default 100 check (max_equity_percent > 0 and max_equity_percent <= 100),
  updated_at timestamptz not null default clock_timestamp(),
  updated_by text
);
insert into public.platform_raise_limits(network) values ('devnet'),('mainnet') on conflict do nothing;

create table public.client_raise_limits (
  client_id uuid primary key references public.clients(id) on delete cascade,
  annual_raise_cap_eur numeric(14,2) check (annual_raise_cap_eur > 0),
  max_equity_percent numeric(5,2) check (max_equity_percent > 0 and max_equity_percent <= 100),
  note text check (length(note) <= 1000),
  updated_at timestamptz not null default clock_timestamp(),
  updated_by text
);

alter table public.launch_applications
  add column applicant_kind text check (applicant_kind in ('individual','company')),
  add column company_formation_requested boolean not null default false;

alter table public.platform_raise_limits enable row level security;
alter table public.client_raise_limits enable row level security;
revoke all on public.platform_raise_limits, public.client_raise_limits from public, anon, authenticated;
grant all on public.platform_raise_limits, public.client_raise_limits to service_role;

-- Wallets that belong to the same person: the account's linked wallets, or
-- just the wallet itself when it has no account yet.
create or replace function public.applicant_wallets(p_wallet text, p_network text) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select array_agg(w2.wallet) from public.account_wallets w1
       join public.account_wallets w2 on w2.account_id = w1.account_id and w2.network = w1.network
      where w1.wallet = p_wallet and w1.network = p_network),
    array[p_wallet])
$$;

create or replace function public.raise_capacity(
  p_wallet text, p_network text, p_exclude uuid default null, p_year int default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  wallets text[] := public.applicant_wallets(p_wallet, p_network);
  yr int := coalesce(p_year, extract(year from (now() at time zone 'utc'))::int);
  cap numeric; max_eq numeric; used numeric; cap_source text := 'platform';
  o_cap numeric; o_eq numeric;
begin
  select annual_raise_cap_eur, max_equity_percent into cap, max_eq
    from public.platform_raise_limits where network = p_network;
  if cap is null then cap := 3000000; max_eq := 100; end if;
  -- The most permissive override among the person's dossiers wins; overrides
  -- are admin decisions, so any one of them expresses the intended limit.
  select max(l.annual_raise_cap_eur), max(l.max_equity_percent) into o_cap, o_eq
    from public.client_raise_limits l join public.clients c on c.id = l.client_id
   where c.network = p_network and c.wallet = any(wallets);
  if o_cap is not null then cap := o_cap; cap_source := 'client'; end if;
  if o_eq is not null then max_eq := o_eq; end if;
  select coalesce(sum(raise_amount), 0) into used from public.launch_applications
   where network = p_network and applicant_wallet = any(wallets)
     and status in ('pending','needs_changes','approved')
     and extract(year from (coalesce(submitted_at, created_at) at time zone 'utc'))::int = yr
     and (p_exclude is null or id <> p_exclude);
  return jsonb_build_object('year', yr, 'cap', cap, 'used', used, 'remaining', greatest(cap - used, 0),
    'max_equity_percent', max_eq, 'cap_source', cap_source);
end $$;

create or replace function public.enforce_raise_limits() returns trigger
language plpgsql security definer set search_path = '' as $$
declare cap jsonb; person text;
begin
  if new.status not in ('pending','needs_changes','approved') then return new; end if;
  -- Serialize per person (smallest linked wallet) so concurrent submits cannot both fit.
  select min(w) into person from unnest(public.applicant_wallets(new.applicant_wallet, new.network)) w;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('raise-cap:' || new.network || ':' || person, 0));
  cap := public.raise_capacity(new.applicant_wallet, new.network, new.id,
    extract(year from (coalesce(new.submitted_at, new.created_at, now()) at time zone 'utc'))::int);
  if new.raise_amount > (cap->>'remaining')::numeric then
    raise exception 'RAISE_CAP_EXCEEDED remaining=% cap=%', cap->>'remaining', cap->>'cap' using errcode = 'P0001';
  end if;
  if new.equity_offered > (cap->>'max_equity_percent')::numeric then
    raise exception 'EQUITY_CAP_EXCEEDED max=%', cap->>'max_equity_percent' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger launch_applications_raise_limits
  before insert or update of raise_amount, equity_offered, status, applicant_wallet on public.launch_applications
  for each row execute function public.enforce_raise_limits();

revoke all on function public.applicant_wallets(text,text), public.raise_capacity(text,text,uuid,int),
  public.enforce_raise_limits() from public, anon, authenticated;
grant execute on function public.applicant_wallets(text,text), public.raise_capacity(text,text,uuid,int) to service_role;

commit;
