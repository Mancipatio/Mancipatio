-- 0022: Resell listings (Flows doc step: "Token holders can post about the tokens
-- they have and want to sell on Mancipatio"). Off-chain classified posts; the
-- actual settlement stays in the on-chain OTC escrow program.

create table if not exists public.resell_listings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  network text not null default 'devnet',
  seller_wallet text not null,
  mint text not null,
  share_class_pda text,
  asset_pda text,
  asset_label text not null default '',
  amount numeric(36, 0) not null,
  ask_price numeric(36, 8),
  ask_currency text not null default 'USDC',
  note text not null default '',
  contact text not null default '',
  status text not null default 'active' check (status in ('active', 'matched', 'withdrawn', 'removed')),
  linked_offer_pda text,
  moderated_by text,
  moderated_at timestamptz
);

drop trigger if exists resell_listings_touch on public.resell_listings;
create trigger resell_listings_touch before update on public.resell_listings
  for each row execute function public.touch_updated_at();

create index if not exists resell_listings_status_idx on public.resell_listings(status);
create index if not exists resell_listings_seller_idx on public.resell_listings(seller_wallet);
create index if not exists resell_listings_network_idx on public.resell_listings(network);

alter table public.resell_listings enable row level security;
drop policy if exists resell_listings_all on public.resell_listings;
create policy resell_listings_all on public.resell_listings for all using (true) with check (true);
