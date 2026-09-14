-- 0028: Investor passport requests (self-service KYC intake).
-- An investor without an on-chain KycEntry applies from /portfolio (small
-- modal: jurisdiction + note). Admins triage the queue on /admin/kyc and a
-- Super Admin issues the on-chain passport (approve_holder) directly from a
-- request row, or continues in the client workbench. Handled rows keep
-- handled_by / handled_at for the audit trail.
--
-- RLS (W3-RLS): the lockdown matrix for passport_requests lives HERE, not in
-- 0025 — 0025 runs BEFORE this file in numeric order and cannot reference a
-- table that does not exist yet. The anon matrix is SELECT + INSERT + UPDATE,
-- NO DELETE (replaces the old permissive `for all using(true)`, which also
-- granted anon DELETE): portfolio submits requests and admin/kyc marks them
-- handled, both still client-side (submitPassportRequest is the single rewrite
-- point when these move behind a signed route). onboarding/passport approval is
-- on-chain (approve_holder) — flipping status here only affects triage state.

create table if not exists public.passport_requests (
  id uuid primary key default gen_random_uuid(),
  wallet text not null,
  registry_pda text,
  jurisdiction int,
  note text,
  status text not null default 'new' check (status in (
    'new', 'in_review', 'approved', 'rejected'
  )),
  handled_by text,
  handled_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists passport_requests_wallet_idx on public.passport_requests(wallet);
create index if not exists passport_requests_status_idx on public.passport_requests(status);

alter table public.passport_requests enable row level security;
-- Drop the historical permissive policy (and any name drift) then recreate the
-- SELECT/INSERT/UPDATE-only matrix (no anon DELETE).
drop policy if exists passport_requests_all on public.passport_requests;
drop policy if exists "passport_requests anon read" on public.passport_requests;
drop policy if exists "passport_requests anon insert" on public.passport_requests;
drop policy if exists "passport_requests anon update" on public.passport_requests;
create policy "passport_requests anon read"
  on public.passport_requests for select using (true);
create policy "passport_requests anon insert"
  on public.passport_requests for insert with check (true);
create policy "passport_requests anon update"
  on public.passport_requests for update using (true) with check (true);
