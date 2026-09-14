-- 0031_rls_followup.sql — drop the TEMP anon write policies left by 0025/0028
--
-- ============================================================================
-- PRIMENITI TEK POSLE deploy-a fronta sa ovim izmenama.
-- (Apply ONLY AFTER the front with the wave-1 signed routes — /api/spvs/*,
-- /api/passport/*, /api/compliance/*, /api/launchpad/*, /api/issuer-profiles/*,
-- /api/fees/*, /api/admin-config/*, /api/vesting/*, /api/storage/* — is live.
-- Applying early breaks every admin/issuer write flow on the running site.)
--
-- PRE-APPLY CHECKLIST:
--   1. Deploy the front FIRST (see above).
--   2. Uploads use the two-step signed-URL flow: POST /api/storage/upload
--      carries only a small signed JSON (authz) and returns a one-time
--      Supabase upload token; the FILE goes browser -> supabase.co directly
--      via uploadToSignedUrl. No app-server body limits apply (Vercel's
--      ~4.5MB serverless cap is irrelevant). Smoke-test one whitepaper
--      upload on the deployed site after apply.
--   3. OPS FOLLOW-UP after apply: objects of the confidential categories
--      (compliance/, issuer-agreement/, other/) uploaded BEFORE this
--      migration still live in the PUBLIC `documents` bucket, and a public
--      bucket serves /storage/v1/object/public/... WITHOUT consulting RLS —
--      so they stay fetchable by anyone who knows (or guesses) the path
--      until moved. Move them to `documents-confidential` via the Storage
--      API/dashboard (supabase.storage move happens bucket-internal only, so
--      download + re-upload to the private bucket, keep identical paths —
--      the admin list route already prefers the private bucket and falls
--      back to the public URL until then).
-- ============================================================================
--
-- 0025 kept anon INSERT/UPDATE/DELETE on the tables below because their writes
-- were still client-side ("not moved in P1"). The follow-up wave moved ALL of
-- those writes behind signed service-role routes (service role bypasses RLS,
-- so the routes are unaffected by everything in this file). This migration
-- drops the residual write policies and tightens seven tables to default-deny
-- (fee_config, fee_waivers, integrations, notifications, compliance_alerts,
-- passport_requests, documents).
--
-- Every kept/dropped verb below was independently re-grepped against the
-- working tree on 2026-07-19: ZERO client-side (anon-key) .insert/.update/
-- .upsert/.delete and ZERO client-side storage .upload remain outside app/api
-- and lib/server. Client-side SELECTs are exactly the ones listed.
--
-- TARGET MATRIX after this file (anon key; only tables this file governs):
--   table                  SELECT  writes  read call sites (anon)           write path (service role)
--   spvs                     ✔       —     lib/spvs.ts listSpvs/getSpv      /api/spvs/create|update
--                                          (admin/spvs, marketplace asset)
--   spv_issuances            ✔       —     lib/spvs.ts listIssuances +      /api/spvs/record-issuance
--                                          yearIssuanceTotal pre-check      (cap_override → super admin)
--   passport_requests        —       —     admin queue moved to signed      /api/passport/submit|update|list
--                                          /api/passport/list; portfolio
--                                          card uses minimal unsigned
--                                          /api/passport/status (id/status/
--                                          created_at of own open request —
--                                          table deanonymizes the KYC
--                                          pipeline, must NOT be anon-read)
--   compliance_alerts        —       —     reads moved to signed            /api/compliance/create|resolve|list
--                                          /api/compliance/list (regulated
--                                          AML/sanctions data — the single
--                                          most sensitive table here)
--   launch_listings          ✔       —     lib/launchpad.ts listings        /api/launchpad/listing-upsert
--   commitments              ✔       —     lib/launchpad.ts aggregate       /api/launchpad/commit|
--                                                                           record-purchase|commitment-status
--   issuer_profiles          ✔       —     lib/issuer-profiles.ts reads     /api/issuer-profiles/upsert
--   fee_config               —       —     reads moved to /api/fees/list    /api/fees/config-*
--   fee_waivers              —       —     reads moved to /api/fees/list    /api/fees/waiver-*
--   jurisdictions            ✔       —     admin/jurisdictions page read    /api/admin-config/jurisdictions-upsert
--                                          (public geo-config)
--   integrations             —       —     reads moved to signed            /api/admin-config/integrations-update
--                                          /api/admin-config/read
--   notifications            —       —     reads moved to signed            /api/admin-config/notifications-create
--                                          /api/admin-config/read           (+ OTC route service-role insert)
--                                          (holds per-wallet OTC traces —
--                                          must NOT be anon-readable)
--   documents (table)        —       —     reads moved to signed            /api/storage/documents/create|
--                                          /api/storage/documents/list      publish|list
--                                          (rows expose storage_path for
--                                          unpublished drafts + confidential
--                                          categories — enumeration surface)
--   vesting_schedules        ✔       —     issuer/vesting list + [id]       /api/vesting/create|update-status
--   vesting_milestones       ✔       —     issuer/vesting/[id]              /api/vesting/create|publish-milestone
--   vesting_beneficiaries    ✔       —     issuer/vesting/[id]              /api/vesting/create
--   vesting_claims           ✔       —     issuer/vesting/[id]              indexer/service-role only
--
-- Untouched (already SELECT-only or governed elsewhere): clients (incl. its
-- 0025 column-grant surgery), launch_updates, launch_applications,
-- application_events, payouts, payout_recipients, asset_profiles,
-- audit_events, tos_acceptances, delivery/resell/otc/custom_inquiries,
-- indexer mirror tables (0002).
--
-- Storage: anon INSERT ("documents anon write") and the narrow whitepapers/
-- UPDATE policy from 0025 are DROPPED — uploads now go through
-- /api/storage/upload (service role, payload-hash bound signature).
-- allowed_mime_types is pinned to the route's allowlist. The public-read
-- policy is NARROWED to whitepapers/ + PUBLISHED public-category documents,
-- and a new PRIVATE bucket `documents-confidential` (service-role only)
-- receives all compliance/issuer-agreement/other uploads — see section 4.
--
-- Idempotent: name-drift-immune pg_policies loops + drop policy if exists,
-- same method as 0025.

-- ---------------------------------------------------------------------------
-- 1. Drop every non-SELECT anon policy on the governed tables.
--    (cmd <> 'SELECT' also catches permissive FOR ALL policies and any
--    historical name drift; covers spv_issuances "anon insert with check
--    (cap_override = false)", the fee_config/fee_waivers anon DELETEs, and
--    the passport_requests INSERT/UPDATE from 0028.)
-- ---------------------------------------------------------------------------

do $$
declare
  pol record;
begin
  for pol in
    select policyname, tablename
    from pg_policies
    where schemaname = 'public'
      and cmd <> 'SELECT'
      and tablename in (
        'spvs', 'spv_issuances',
        'passport_requests',
        'compliance_alerts',
        'launch_listings', 'commitments',
        'issuer_profiles',
        'fee_config', 'fee_waivers',
        'jurisdictions',
        'integrations', 'notifications',
        'documents',
        'vesting_schedules', 'vesting_milestones', 'vesting_beneficiaries',
        'vesting_claims'
      )
  loop
    execute format('drop policy %I on public.%I', pol.policyname, pol.tablename);
  end loop;
end $$;

-- 0025 narrowed the anon UPDATE on spvs to a column list (grant update (...)).
-- The UPDATE policy is gone now, so RLS already denies, but remove the stale
-- column-level grant too — no anon UPDATE privilege should survive.
-- (Revoking a privilege that is not held is a no-op, not an error.)
revoke update (
  name, registration_number, country, status, client_id, issuer_pda,
  incorporated_at, notes
) on public.spvs from anon;
revoke update on public.spvs from anon;

-- ---------------------------------------------------------------------------
-- 2. Default-deny tables: reads moved behind signed routes in this wave.
--    fee_config / fee_waivers  → /api/fees/list (requireAdmin)
--    integrations              → /api/admin-config/read (requireAdmin;
--                                vendor inventory + health + free-form config)
--    notifications             → /api/admin-config/read (requireAdmin;
--                                contains per-wallet OTC deal traces)
--    compliance_alerts         → /api/compliance/list (requireAdmin;
--                                regulated AML/sanctions screening data)
--    passport_requests         → /api/passport/list (requireAdmin) for the
--                                admin queue; /api/passport/status (unsigned,
--                                rate-limited, id/status/created_at of the
--                                caller's own open request ONLY) for the
--                                portfolio card
--    documents                 → /api/storage/documents/list (requireAdmin;
--                                rows expose storage paths of unpublished
--                                and confidential files)
--    Like custom_inquiries in 0025: NO anon policies at all.
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
        'fee_config', 'fee_waivers', 'integrations', 'notifications',
        'compliance_alerts', 'passport_requests', 'documents'
      )
  loop
    execute format('drop policy %I on public.%I', pol.policyname, pol.tablename);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Defensively (re)create the kept anon SELECT policies so this file yields
--    the full target matrix even on a fresh install. All are unscoped reads —
--    each backed by a live client-side call site (see matrix above).
-- ---------------------------------------------------------------------------

alter table public.spvs                  enable row level security;
alter table public.spv_issuances         enable row level security;
alter table public.passport_requests     enable row level security;
alter table public.compliance_alerts     enable row level security;
alter table public.launch_listings       enable row level security;
alter table public.commitments           enable row level security;
alter table public.issuer_profiles       enable row level security;
alter table public.fee_config            enable row level security;
alter table public.fee_waivers           enable row level security;
alter table public.jurisdictions         enable row level security;
alter table public.integrations          enable row level security;
alter table public.notifications         enable row level security;
alter table public.documents             enable row level security;
alter table public.vesting_schedules     enable row level security;
alter table public.vesting_milestones    enable row level security;
alter table public.vesting_beneficiaries enable row level security;
alter table public.vesting_claims        enable row level security;

drop policy if exists "spvs anon read" on public.spvs;
create policy "spvs anon read"
  on public.spvs for select using (true);

drop policy if exists "spv_issuances anon read" on public.spv_issuances;
create policy "spv_issuances anon read"
  on public.spv_issuances for select using (true);

-- passport_requests / compliance_alerts / documents: NO anon SELECT — their
-- reads moved behind signed routes (section 2). Deliberately not recreated.

drop policy if exists "launch_listings anon read" on public.launch_listings;
create policy "launch_listings anon read"
  on public.launch_listings for select using (true);

drop policy if exists "commitments anon read" on public.commitments;
create policy "commitments anon read"
  on public.commitments for select using (true);

drop policy if exists "issuer_profiles anon read" on public.issuer_profiles;
create policy "issuer_profiles anon read"
  on public.issuer_profiles for select using (true);

drop policy if exists "jurisdictions anon read" on public.jurisdictions;
create policy "jurisdictions anon read"
  on public.jurisdictions for select using (true);

drop policy if exists "vesting_schedules anon read" on public.vesting_schedules;
create policy "vesting_schedules anon read"
  on public.vesting_schedules for select using (true);

drop policy if exists "vesting_milestones anon read" on public.vesting_milestones;
create policy "vesting_milestones anon read"
  on public.vesting_milestones for select using (true);

drop policy if exists "vesting_beneficiaries anon read" on public.vesting_beneficiaries;
create policy "vesting_beneficiaries anon read"
  on public.vesting_beneficiaries for select using (true);

drop policy if exists "vesting_claims anon read" on public.vesting_claims;
create policy "vesting_claims anon read"
  on public.vesting_claims for select using (true);

-- ---------------------------------------------------------------------------
-- 4. Storage — buckets 'documents' (public) + 'documents-confidential' (NEW,
--    private)
--    Uploads moved to /api/storage/upload (service role; wallet signature
--    binds sha256+size+path+MIME). The route now splits destinations by
--    category prefix: whitepapers/legal/kyb-template/marketing stay in the
--    public bucket; compliance/issuer-agreement/other go to the private one
--    and are served ONLY via service-role signed URLs
--    (/api/storage/documents/list).
-- ---------------------------------------------------------------------------

-- Anon INSERT: dropped (0025 kept it for the then-client-side uploads).
drop policy if exists "documents anon write" on storage.objects;

-- Narrow whitepapers/ UPDATE from 0025: dropped — the route uses the service
-- role for its upsert:true re-save of content-addressed whitepaper paths.
drop policy if exists "documents anon update" on storage.objects;

-- Belt-and-braces: no anon DELETE either (0025 already dropped it).
drop policy if exists "documents anon delete" on storage.objects;

-- NEW private bucket for confidential document categories. No storage.objects
-- policies at all -> default-deny for anon/authenticated; only the service
-- role (upload + signed-URL routes) touches it.
insert into storage.buckets (id, name, public)
values ('documents-confidential', 'documents-confidential', false)
on conflict (id) do update set public = excluded.public;

-- Public read NARROWED. The old policy allowed SELECT on every object in the
-- bucket, which let the anon key LIST all objects — including confidential
-- and unpublished ones — via the storage API. Now anon can only see:
--   - whitepapers/ (public by design, content-addressed paths), and
--   - objects belonging to a PUBLISHED documents row in a public category
--     (legal / kyb-template / marketing).
-- NOTE on semantics: while the bucket has public = true, raw
-- /storage/v1/object/public/... GETs bypass RLS entirely — the bucket must
-- stay public for the whitepaper/marketing raw URLs to keep working, so this
-- policy closes the LISTING/enumeration hole and the metadata-table lockdown
-- (section 2) removes path discovery. Direct-URL exposure of PRE-EXISTING
-- confidential objects persists until the ops move in the header checklist;
-- all NEW confidential uploads land in the private bucket and are never
-- publicly addressable.
create or replace function public.storage_path_is_public_doc(p text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.documents d
    where d.storage_path = p
      and d.published
      and d.category in ('legal', 'kyb-template', 'marketing')
  );
$$;
-- security definer: the policy below must evaluate this against the
-- (now default-deny) documents table regardless of the caller's role.
revoke all on function public.storage_path_is_public_doc(text) from public;
grant execute on function public.storage_path_is_public_doc(text)
  to anon, authenticated, service_role;

drop policy if exists "documents public read" on storage.objects;
create policy "documents public read"
  on storage.objects for select
  using (
    bucket_id = 'documents'
    and (
      name like 'whitepapers/%'
      or public.storage_path_is_public_doc(name)
    )
  );

-- Pin the buckets to the upload route's MIME allowlist (pdf, png, jpg, docx)
-- and re-assert the 25 MiB cap. 0025 deliberately skipped the MIME allowlist
-- while anon uploads were live; with all uploads behind the route the two
-- limits are now enforced at BOTH layers and cannot drift apart silently.
-- Guarded: allowed_mime_types may not exist on older storage schemas.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'storage'
      and table_name = 'buckets'
      and column_name = 'allowed_mime_types'
  ) then
    update storage.buckets
      set allowed_mime_types = array[
        'application/pdf',
        'image/png',
        'image/jpeg',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      ]
      where id in ('documents', 'documents-confidential');
  end if;
end $$;

update storage.buckets
  set file_size_limit = 26214400 -- 25 MiB (matches the route's cap)
  where id in ('documents', 'documents-confidential');
