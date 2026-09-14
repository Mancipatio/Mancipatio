-- 0020: Delivery requests (Flows doc, fungible/non-fungible steps 13-16).
-- A token holder (onboarded client) asks for physical delivery; admin approves,
-- opens a DeliveryEscrow custody vault, the holder deposits tokens, and the
-- vault is realized (burn) on delivery confirmation or returned on cancel.

create table if not exists public.delivery_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  network text not null default 'devnet',
  holder_wallet text not null,
  client_id uuid references public.clients(id) on delete set null,
  share_class_pda text not null,
  mint text not null,
  asset_pda text,
  asset_label text not null default '',
  amount numeric(36, 0) not null,
  delivery_details text not null default '',
  contact text not null default '',
  status text not null default 'requested' check (status in (
    'requested', 'approved', 'vault_opened', 'deposited',
    'in_delivery', 'delivered', 'cancelled', 'returned'
  )),
  vault_pda text,
  vault_id numeric(20, 0),
  admin_note text,
  decided_by text,
  decided_at timestamptz,
  deposit_tx text,
  outcome_tx text
);

drop trigger if exists delivery_requests_touch on public.delivery_requests;
create trigger delivery_requests_touch before update on public.delivery_requests
  for each row execute function public.touch_updated_at();

create index if not exists delivery_requests_wallet_idx on public.delivery_requests(holder_wallet);
create index if not exists delivery_requests_status_idx on public.delivery_requests(status);
create index if not exists delivery_requests_network_idx on public.delivery_requests(network);

alter table public.delivery_requests enable row level security;
drop policy if exists delivery_requests_all on public.delivery_requests;
create policy delivery_requests_all on public.delivery_requests for all using (true) with check (true);
