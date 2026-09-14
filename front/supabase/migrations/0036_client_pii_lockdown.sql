-- 0036_client_pii_lockdown.sql — lock down the client/KYC/application PII tables.
--
-- ============================================================================
-- APPLY ONLY AFTER deploying the front that reads these tables through the new
-- signed / token / minimal-status routes. Applying early breaks the admin
-- client directory, the client-detail page, onboarding, /apply, the admin
-- application queue, the public deal pages and the ToS gate.
-- ============================================================================
--
-- 0025 kept blanket `using(true)` anon SELECT on the tables below because their
-- reads were still client-side (anon key). Anyone with NEXT_PUBLIC_SUPABASE_
-- ANON_KEY (shipped in the browser bundle) could therefore dump the entire
-- client directory (names, emails, KYC verdicts), every internal admin note,
-- every KYC requirement, every founder application (email, valuation, revenue)
-- and every investor commitment. This wave moved all of those reads behind
-- routes (service role bypasses RLS), so the anon SELECT policies are dropped.
--
-- READ PATHS AFTER THIS FILE:
--   clients            → clients.adminList / adminDetail / lookup (SIWS+admin),
--                        clients.me (SIWS self), onboarding-view (token)
--   client_notes       → clients.adminDetail (SIWS + admin)
--   client_documents   → clients.adminDetail (SIWS + admin); doc bytes already
--                        private (client-documents bucket, signed URLs)
--   kyc_requirements   → clients.adminDetail (SIWS + admin),
--                        clients/onboarding-requirements (token, own row)
--   tos_acceptances    → /api/tos/status (minimal unsigned per-wallet boolean)
--   launch_applications→ applications.adminList (SIWS + admin),
--                        applications.mine (SIWS self),
--                        /api/applications/public (approved rows, non-PII cols)
--   application_events → applications.adminEvents (SIWS + admin),
--                        applications.mine (SIWS self)
--   commitments        → /api/launchpad/commitment-aggregate (raised/backers
--                        only; individual rows never exposed)
--
-- WRITE PATHS were already server-side (service role) for every one of these
-- tables, so the residual anon INSERT/UPDATE on commitments is dropped too.
--
-- Idempotent: pg_policies loops + drop-if-exists, same method as 0025/0031.

-- ---------------------------------------------------------------------------
-- 1. Drop EVERY anon policy (SELECT and, for commitments, INSERT/UPDATE) on the
--    governed tables. cmd-agnostic loop also catches any historical name drift.
-- ---------------------------------------------------------------------------
do $$
declare
  pol record;
begin
  for pol in
    select policyname, tablename
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'clients', 'client_notes', 'client_documents', 'kyc_requirements',
        'tos_acceptances',
        'launch_applications', 'application_events',
        'commitments'
      )
  loop
    execute format('drop policy %I on public.%I', pol.policyname, pol.tablename);
  end loop;
end $$;

-- 0025 revoked table-level SELECT on clients and re-granted it per-column
-- (excluding onboarding_token). With the anon SELECT policy gone, RLS already
-- denies anon reads; remove the residual column grant so no anon SELECT
-- privilege survives at all. (Revoking a privilege not held is a no-op.)
revoke select on public.clients from anon;

-- ---------------------------------------------------------------------------
-- 2. Re-assert RLS enabled (default-deny) on every governed table. No anon
--    policies are recreated — all reads/writes go through service-role routes.
-- ---------------------------------------------------------------------------
alter table public.clients             enable row level security;
alter table public.client_notes        enable row level security;
alter table public.client_documents    enable row level security;
alter table public.kyc_requirements    enable row level security;
alter table public.tos_acceptances     enable row level security;
alter table public.launch_applications enable row level security;
alter table public.application_events  enable row level security;
alter table public.commitments         enable row level security;
