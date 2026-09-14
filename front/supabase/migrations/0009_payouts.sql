-- 0009_payouts.sql
-- Distribution / drop tooling. A "payout" is one snapshot-based distribution
-- (dividend, buyback, airdrop). The snapshot is materialized as
-- payout_recipients rows. Once the Merkle root is computed it is stored on
-- the payout; per-recipient proofs are stored on payout_recipients so the
-- claim UI can serve them straight from the DB.
--
-- v0.1: snapshot is operator-asserted (CSV upload or a Supabase indexer
-- query). The on-chain funding + claim instructions ship in a later phase;
-- this table is the source of truth for "who is owed what" until then.

create table if not exists public.payouts (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- Asset this payout is tied to. asset_label is denormalised for the list
  -- view so we don't need a join when rendering the table.
  asset_mint       text not null,
  asset_label      text not null default '',

  kind             text not null
    check (kind in ('dividend', 'buyback', 'airdrop', 'other')),

  -- Money side. Currency is free-form ("USDC", "SOL", "USD") so we can
  -- handle fiat-priced dividends and on-chain ones with the same table.
  total_amount     numeric(36, 8) not null default 0,
  currency         text not null default 'USDC',
  per_share        numeric(36, 8),

  -- Snapshot metadata.
  snapshot_at      timestamptz not null default now(),
  snapshot_source  text not null default 'csv'
    check (snapshot_source in ('csv', 'indexer', 'manual')),
  holder_count     integer not null default 0,
  total_shares     numeric(36, 8) not null default 0,

  -- Merkle. The root is base16 (hex) for readability; the on-chain version
  -- will accept either base58 or hex.
  merkle_root      text,
  merkle_built_at  timestamptz,

  -- Funding / lifecycle.
  status           text not null default 'draft'
    check (status in ('draft', 'snapshot_taken', 'merkle_built', 'funded',
                      'live', 'claimed_full', 'cancelled')),
  funded_tx        text,
  funded_at        timestamptz,

  notes            text not null default '',
  author           text not null              -- admin wallet
);

create index if not exists payouts_asset_mint_idx on public.payouts (asset_mint);
create index if not exists payouts_status_idx     on public.payouts (status);
create index if not exists payouts_created_idx    on public.payouts (created_at desc);

create trigger payouts_touch before update on public.payouts
  for each row execute function public.touch_updated_at();

alter table public.payouts enable row level security;

drop policy if exists "payouts anon read"   on public.payouts;
create policy "payouts anon read"
  on public.payouts for select using (true);

drop policy if exists "payouts anon insert" on public.payouts;
create policy "payouts anon insert"
  on public.payouts for insert with check (true);

drop policy if exists "payouts anon update" on public.payouts;
create policy "payouts anon update"
  on public.payouts for update using (true) with check (true);

drop policy if exists "payouts anon delete" on public.payouts;
create policy "payouts anon delete"
  on public.payouts for delete using (true);

------------------------------------------------------------------------------

create table if not exists public.payout_recipients (
  payout_id     uuid not null references public.payouts (id) on delete cascade,
  wallet        text not null,
  shares        numeric(36, 8) not null default 0,
  amount        numeric(36, 8) not null default 0,
  merkle_index  integer not null,
  merkle_proof  jsonb not null default '[]'::jsonb,
  claimed       boolean not null default false,
  claimed_at    timestamptz,
  claimed_tx    text,
  primary key (payout_id, wallet)
);

create index if not exists payout_recipients_payout_idx  on public.payout_recipients (payout_id);
create index if not exists payout_recipients_wallet_idx  on public.payout_recipients (wallet);
create index if not exists payout_recipients_claimed_idx on public.payout_recipients (claimed) where claimed;

alter table public.payout_recipients enable row level security;

drop policy if exists "payout_recipients anon read"   on public.payout_recipients;
create policy "payout_recipients anon read"
  on public.payout_recipients for select using (true);

drop policy if exists "payout_recipients anon insert" on public.payout_recipients;
create policy "payout_recipients anon insert"
  on public.payout_recipients for insert with check (true);

drop policy if exists "payout_recipients anon update" on public.payout_recipients;
create policy "payout_recipients anon update"
  on public.payout_recipients for update using (true) with check (true);

drop policy if exists "payout_recipients anon delete" on public.payout_recipients;
create policy "payout_recipients anon delete"
  on public.payout_recipients for delete using (true);
