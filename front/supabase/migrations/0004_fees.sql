-- 0004_fees.sql
-- Off-chain fee configuration table.
-- On-chain, Platform stores a single protocol_fee_bps + protocol_treasury.
-- These rows extend that with per-flow fee types (issuance / sale / OTC /
-- conversion / withdrawal) and per-recipient splits. Read by the UI to
-- estimate fees pre-tx and to drive the revenue dashboard once we wire
-- event-derived totals.

create table if not exists public.fee_config (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  network         text not null default 'devnet',

  -- Which flow the fee applies to.
  fee_type        text not null
    check (fee_type in (
      'issuance', 'sale', 'otc', 'conversion', 'withdrawal',
      'mint', 'governance'
    )),

  -- Default rate, in basis points (250 = 2.5%). Overridden per-client by
  -- fee_waivers rows.
  rate_bps        integer not null default 0
    check (rate_bps >= 0 and rate_bps <= 10000),

  -- Who receives the fee. For multi-recipient splits, insert multiple rows
  -- with the same fee_type and use share_bps to apportion.
  recipient       text not null,        -- wallet
  share_bps       integer not null default 10000
    check (share_bps > 0 and share_bps <= 10000),

  -- Operational labels.
  label           text not null default '',
  enabled         boolean not null default true,

  unique (network, fee_type, recipient)
);
create index if not exists fee_config_type_idx on public.fee_config (network, fee_type);
create trigger fee_config_touch before update on public.fee_config
  for each row execute function public.touch_updated_at();

------------------------------------------------------------------------------
-- Waivers — per-client overrides.
------------------------------------------------------------------------------
create table if not exists public.fee_waivers (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  network       text not null default 'devnet',
  client_id     uuid not null references public.clients(id) on delete cascade,
  fee_type      text not null
    check (fee_type in (
      'issuance', 'sale', 'otc', 'conversion', 'withdrawal',
      'mint', 'governance'
    )),
  -- Override rate; 0 = full waiver, otherwise reduced rate.
  override_bps  integer not null
    check (override_bps >= 0 and override_bps <= 10000),
  expires_at    timestamptz,
  reason        text not null default '',
  granted_by    text not null,           -- admin wallet
  unique (network, client_id, fee_type)
);
create index if not exists fee_waivers_client_idx on public.fee_waivers (client_id);
create index if not exists fee_waivers_type_idx   on public.fee_waivers (network, fee_type);
create trigger fee_waivers_touch before update on public.fee_waivers
  for each row execute function public.touch_updated_at();

------------------------------------------------------------------------------
-- RLS — read public, insert/update/delete open in v0.1 (anon writes from the
-- admin UI). Tighten once we move privileged writes to a server endpoint.
------------------------------------------------------------------------------
alter table public.fee_config   enable row level security;
alter table public.fee_waivers  enable row level security;

drop policy if exists "fee_config anon read"   on public.fee_config;
create policy "fee_config anon read"
  on public.fee_config for select using (true);

drop policy if exists "fee_config anon insert" on public.fee_config;
create policy "fee_config anon insert"
  on public.fee_config for insert with check (true);

drop policy if exists "fee_config anon update" on public.fee_config;
create policy "fee_config anon update"
  on public.fee_config for update using (true) with check (true);

drop policy if exists "fee_config anon delete" on public.fee_config;
create policy "fee_config anon delete"
  on public.fee_config for delete using (true);

drop policy if exists "fee_waivers anon read"   on public.fee_waivers;
create policy "fee_waivers anon read"
  on public.fee_waivers for select using (true);

drop policy if exists "fee_waivers anon insert" on public.fee_waivers;
create policy "fee_waivers anon insert"
  on public.fee_waivers for insert with check (true);

drop policy if exists "fee_waivers anon update" on public.fee_waivers;
create policy "fee_waivers anon update"
  on public.fee_waivers for update using (true) with check (true);

drop policy if exists "fee_waivers anon delete" on public.fee_waivers;
create policy "fee_waivers anon delete"
  on public.fee_waivers for delete using (true);
