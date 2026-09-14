-- 0024: OTC escrow requests (business-doc §9).
-- Seller and buyer agree on amount and price (they can negotiate via the
-- resell board), then one of them submits a request for smart-contract
-- creation. An admin reviews the request and opens the on-chain `OtcDeal`
-- escrow (create_otc_deal); the platform shares the deal PDA with both
-- parties, each deposits its leg, and the swap settles automatically once
-- both legs are funded — otherwise the deposited leg is refunded on
-- expire_otc_deal / cancel_otc_deal.

create table if not exists public.otc_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  network text not null default 'devnet',
  share_class_pda text not null,
  mint text not null,
  asset_label text not null default '',
  seller_wallet text not null,
  buyer_wallet text not null,
  amount numeric(36, 0) not null,
  price numeric(36, 0) not null,
  payment_mint text not null,
  requested_by text not null,
  status text not null default 'requested' check (status in (
    'requested', 'created', 'cancelled', 'completed', 'expired'
  )),
  deal_pda text,
  deal_id numeric(20, 0),
  expires_at timestamptz,
  admin_note text,
  decided_by text,
  decided_at timestamptz
);

drop trigger if exists otc_requests_touch on public.otc_requests;
create trigger otc_requests_touch before update on public.otc_requests
  for each row execute function public.touch_updated_at();

create index if not exists otc_requests_seller_idx on public.otc_requests(seller_wallet);
create index if not exists otc_requests_buyer_idx on public.otc_requests(buyer_wallet);
create index if not exists otc_requests_status_idx on public.otc_requests(status);
create index if not exists otc_requests_network_idx on public.otc_requests(network);

alter table public.otc_requests enable row level security;
drop policy if exists otc_requests_all on public.otc_requests;
create policy otc_requests_all on public.otc_requests for all using (true) with check (true);
