-- 0016: Terms-of-Service acceptance (Flows & Fact Sheets: onboarding includes accepting ToS).
-- Adds acceptance columns on clients + an append-only acceptance log.

alter table public.clients
  add column if not exists tos_accepted_at timestamptz,
  add column if not exists tos_version text;

create table if not exists public.tos_acceptances (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  client_id uuid not null references public.clients(id) on delete cascade,
  wallet text,
  version text not null,
  source text not null default 'onboarding'
);

create index if not exists tos_acceptances_client_idx on public.tos_acceptances(client_id);

-- RLS open (v0.1) — tighten behind SIWS later, same as the rest of the schema.
alter table public.tos_acceptances enable row level security;
drop policy if exists tos_acceptances_read on public.tos_acceptances;
create policy tos_acceptances_read on public.tos_acceptances for select using (true);
drop policy if exists tos_acceptances_insert on public.tos_acceptances;
create policy tos_acceptances_insert on public.tos_acceptances for insert with check (true);
