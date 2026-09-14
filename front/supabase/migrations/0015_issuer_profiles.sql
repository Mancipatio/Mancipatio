-- 0015_issuer_profiles.sql
-- Off-chain onboarding profile for each on-chain Issuer.
-- The on-chain Issuer account only stores legal_entity_id, jurisdiction and KYB
-- status; the company name, contact email and website collected during the
-- issuer onboarding wizard have nowhere to live on-chain, so they land here,
-- keyed by the Issuer PDA. The Super Admin KYB review reads this row to see who
-- they're verifying.
--
-- RLS posture follows the existing v0.1 pattern (anon read + write). Tighten in
-- the server-route migration (see docs/2026-06-22-overnight-audit.md).

create table if not exists public.issuer_profiles (
  issuer_pda       text primary key,                 -- = findIssuerPda(legal_entity_id)
  legal_entity_id  text,                              -- decoded bytes32 seed, for readability
  network          text not null default 'devnet',
  company_name     text,
  contact_email    text,
  website          text,
  created_by       text,                              -- authority wallet that onboarded
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists issuer_profiles_network_idx on public.issuer_profiles (network);
create index if not exists issuer_profiles_legal_idx   on public.issuer_profiles (legal_entity_id);

drop trigger if exists issuer_profiles_touch on public.issuer_profiles;
create trigger issuer_profiles_touch before update on public.issuer_profiles
  for each row execute function public.touch_updated_at();

alter table public.issuer_profiles enable row level security;

drop policy if exists "issuer_profiles anon read"   on public.issuer_profiles;
drop policy if exists "issuer_profiles anon insert" on public.issuer_profiles;
drop policy if exists "issuer_profiles anon update" on public.issuer_profiles;
drop policy if exists "issuer_profiles anon delete" on public.issuer_profiles;

create policy "issuer_profiles anon read"
  on public.issuer_profiles for select using (true);
create policy "issuer_profiles anon insert"
  on public.issuer_profiles for insert with check (true);
create policy "issuer_profiles anon update"
  on public.issuer_profiles for update using (true) with check (true);
create policy "issuer_profiles anon delete"
  on public.issuer_profiles for delete using (true);
