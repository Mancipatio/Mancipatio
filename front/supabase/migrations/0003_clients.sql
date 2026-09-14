-- 0003_clients.sql
-- Off-chain CRM directory for every KYC'd person on Mancipatio — issuers,
-- investors, delegates, officers. The admin-side onboarding flow from
-- SCOPE §1.7.5 lands here; the on-chain link (issuer authority wallet,
-- holder wallet) is filled in later when the person connects.

create extension if not exists "pgcrypto";

create table if not exists public.clients (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  network             text not null default 'devnet',

  -- Classification
  type                text not null
    check (type in ('issuer', 'investor', 'delegate', 'officer')),
  tier                text,  -- starter / pro / enterprise (free-form)
  tags                jsonb not null default '[]'::jsonb,
  source              text,  -- organic / inbound / referral

  -- Personal / company info
  email               text,
  display_name        text not null default '',
  company_name        text,
  jurisdiction        text,  -- ISO-3166 numeric as string

  -- KYC pipeline
  kyc_status          text not null default 'pending'
    check (kyc_status in ('pending', 'verified', 'rejected', 'suspended', 'expired')),
  kyc_provider        text,  -- 'mock', 'sumsub', 'persona' …
  kyc_provider_ref    text,
  kyc_verified_at     timestamptz,
  kyc_expires_at      timestamptz,

  -- Onboarding state
  onboarding_token    text unique,         -- magic-link secret
  onboarding_status   text not null default 'invited'
    check (onboarding_status in ('invited', 'connected', 'verified', 'rejected', 'completed')),

  -- On-chain link (populated when client connects + verifies)
  wallet              text,                -- Solana address
  issuer_pda          text,                -- if type=issuer and registered

  -- Operational
  suspended_at        timestamptz,
  notes_count         integer not null default 0,
  last_activity_at    timestamptz
);

create index if not exists clients_type_idx       on public.clients (type);
create index if not exists clients_kyc_status_idx on public.clients (kyc_status);
create index if not exists clients_wallet_idx     on public.clients (wallet);
create index if not exists clients_email_idx      on public.clients (email);
create index if not exists clients_network_idx    on public.clients (network);
create index if not exists clients_created_at_idx on public.clients (created_at desc);

create trigger clients_touch before update on public.clients
  for each row execute function public.touch_updated_at();

------------------------------------------------------------------------------
-- Notes — internal CRM messages per client.
------------------------------------------------------------------------------
create table if not exists public.client_notes (
  id           bigserial primary key,
  created_at   timestamptz not null default now(),
  client_id    uuid not null references public.clients(id) on delete cascade,
  author       text not null,            -- admin wallet
  body         text not null,
  kind         text not null default 'note'
    check (kind in ('note', 'communication', 'kyc-event', 'system'))
);
create index if not exists client_notes_client_id_idx on public.client_notes (client_id, created_at desc);

------------------------------------------------------------------------------
-- Documents — off-chain KYB / KYC docs metadata.
-- File bytes live in Supabase Storage; this row holds the pointer + hash.
------------------------------------------------------------------------------
create table if not exists public.client_documents (
  id            bigserial primary key,
  created_at    timestamptz not null default now(),
  client_id     uuid not null references public.clients(id) on delete cascade,
  kind          text not null,            -- passport / incorporation / board-resolution / ...
  storage_path  text not null,
  sha256        text,
  uploaded_by   text not null,
  size_bytes    bigint
);
create index if not exists client_documents_client_id_idx on public.client_documents (client_id);

------------------------------------------------------------------------------
-- RLS — public read of (non-sensitive parts via view), admin write only.
-- For v0.1 we open everything to anon read; tighten via a view + service-role
-- write in Phase B+.
------------------------------------------------------------------------------
alter table public.clients          enable row level security;
alter table public.client_notes     enable row level security;
alter table public.client_documents enable row level security;

drop policy if exists "clients anon read" on public.clients;
create policy "clients anon read"
  on public.clients for select
  using (true);

drop policy if exists "clients anon insert" on public.clients;
create policy "clients anon insert"
  on public.clients for insert
  with check (true);

drop policy if exists "clients anon update" on public.clients;
create policy "clients anon update"
  on public.clients for update
  using (true)
  with check (true);

drop policy if exists "client_notes anon read" on public.client_notes;
create policy "client_notes anon read"
  on public.client_notes for select
  using (true);

drop policy if exists "client_notes anon insert" on public.client_notes;
create policy "client_notes anon insert"
  on public.client_notes for insert
  with check (true);

drop policy if exists "client_documents anon read" on public.client_documents;
create policy "client_documents anon read"
  on public.client_documents for select
  using (true);

drop policy if exists "client_documents anon insert" on public.client_documents;
create policy "client_documents anon insert"
  on public.client_documents for insert
  with check (true);

-- No DELETE policies — soft-delete via suspended_at + service-role for GDPR
-- erasure flow.
