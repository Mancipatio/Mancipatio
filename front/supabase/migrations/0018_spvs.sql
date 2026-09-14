-- 0018: SPV registry (Flows doc: Serbian SPV required for company-ownership / debt /
-- revenue-share issuance; max EUR 3M issued per SPV per calendar year).

create table if not exists public.spvs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  network text not null default 'devnet',
  name text not null,
  registration_number text,
  country text not null default '688', -- ISO-3166 numeric, Serbia
  status text not null default 'planned' check (status in ('planned', 'incorporating', 'active', 'retired')),
  client_id uuid references public.clients(id) on delete set null,
  issuer_pda text,
  incorporated_at date,
  annual_cap_eur numeric(18, 2) not null default 3000000,
  notes text not null default ''
);

drop trigger if exists spvs_touch on public.spvs;
create trigger spvs_touch before update on public.spvs
  for each row execute function public.touch_updated_at();

create index if not exists spvs_network_idx on public.spvs(network);
create index if not exists spvs_status_idx on public.spvs(status);
create index if not exists spvs_client_idx on public.spvs(client_id);

create table if not exists public.spv_issuances (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  spv_id uuid not null references public.spvs(id) on delete cascade,
  asset_pda text,
  sale_pubkey text,
  amount_eur numeric(18, 2) not null,
  issued_at date not null default current_date,
  note text,
  recorded_by text
);

create index if not exists spv_issuances_spv_idx on public.spv_issuances(spv_id);
create index if not exists spv_issuances_issued_idx on public.spv_issuances(issued_at);

-- Link assets to the SPV they are issued through.
alter table public.asset_profiles
  add column if not exists spv_id uuid references public.spvs(id) on delete set null;

alter table public.spvs enable row level security;
alter table public.spv_issuances enable row level security;
drop policy if exists spvs_all on public.spvs;
create policy spvs_all on public.spvs for all using (true) with check (true);
drop policy if exists spv_issuances_all on public.spv_issuances;
create policy spv_issuances_all on public.spv_issuances for all using (true) with check (true);
