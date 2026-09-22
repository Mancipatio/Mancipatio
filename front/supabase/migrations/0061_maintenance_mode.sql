-- Maintenance mode, one row per network (no row = not in maintenance).
-- While enabled, the app refuses signed writes and wallet transactions with
-- 503 and shows the message in a banner (lib/server/maintenance.ts); reads,
-- sign-in, the indexer webhook and the retry worker keep running. Operators
-- switch it with scripts/ops/maintenance.sh (service role only).
-- The flag and its message are public; who changed it is not.
begin;

create table if not exists public.platform_maintenance (
  network text primary key check (network in ('devnet','mainnet','testnet','localnet')),
  enabled boolean not null default false,
  message text check (length(message) <= 500),
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table public.platform_maintenance enable row level security;
revoke all on public.platform_maintenance from public, anon, authenticated;
drop policy if exists "public maintenance flag" on public.platform_maintenance;
create policy "public maintenance flag" on public.platform_maintenance for select to anon, authenticated using (true);
grant select (network, enabled, message, updated_at) on public.platform_maintenance to anon, authenticated;
grant all on public.platform_maintenance to service_role;

commit;
