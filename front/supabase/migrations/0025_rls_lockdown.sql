-- 0025_rls_lockdown.sql — consolidated RLS lockdown + storage (W3-RLS)
--
-- ============================================================================
-- APPLY ONLY AFTER the front with server routes (waves 1+2) is deployed AND
-- SUPABASE_SERVICE_ROLE_KEY is set in Vercel — applying early breaks the live
-- site's writes. Also apply 0026–0030 in the same deploy window (0029 is
-- required before wallet-only ToS acceptance inserts work).
-- ============================================================================
--
-- Numbered 0025 but written LAST: it consolidates the target anon-policy
-- matrix after wave 2 moved writes behind server routes (service role
-- bypasses RLS, so routes are unaffected by everything below).
--
-- Method: for each governed table, drop ALL existing policies (immune to
-- historical policy-name drift), then recreate the minimal set. Every kept
-- verb below was cross-checked against an ACTUAL client-side (anon-key) call
-- in lib/ or app/ as of 2026-07-19. Indexer mirror tables (0002) are
-- deliberately untouched — their anon-read/service-write policies are already
-- correct.
--
-- TARGET MATRIX (anon key):
--   table                  SELECT INSERT UPDATE DELETE  note
--   clients                  ✔      —      —      —     admin dir + findClientByWallet + onboarding self-row (SD1)
--   client_notes             ✔      —      —      —     writes via /api/clients/note
--   client_documents         ✔      —      —      —     metadata only; bytes in private bucket
--   kyc_requirements         ✔      —      —      —     writes via /api/clients/*
--   tos_acceptances          ✔      —      —      —     lib/tos.ts gate check; writes via /api/tos/accept
--   launch_applications      ✔      —      —      —     apply page + admin queue read; writes via /api/applications/*
--   application_events       ✔      —      —      —     history timelines; writes server-side
--   launch_listings          ✔      ✔      ✔      —     lib/launchpad.ts upsert still client-side (not moved in P1)
--   launch_updates           ✔      —      —      —     listUpdates read-only
--   commitments              ✔      ✔      ✔      —     lib/launchpad.ts record/settle still client-side
--   delivery_requests        ✔      —      —      —     writes via /api/delivery/* (SD3)
--   resell_listings          ✔      —      —      —     full SELECT (admin board lists all); writes via /api/resell/*
--   otc_requests             ✔      —      —      —     writes via /api/otc/*
--   custom_inquiries         —      —      —      —     NO anon anything (SD4 routes own it all)
--   audit_events             ✔      —      —      —     admin/audit + admin/health read; insert via /api/audit
--   payouts                  ✔      —      —      —     writes via /api/payouts/* (create modal moved by W3-SWEEP)
--   payout_recipients        ✔      —      —      —     writes via /api/payouts/* (create modal moved by W3-SWEEP)
--   asset_profiles           ✔      —      —      —     full SELECT (admin/issuer UIs list drafts); writes via /api/profiles
--   issuer_profiles          ✔      ✔      ✔      —     upsertIssuerProfile still client-side (not moved in P1)
--   spvs                     ✔      ✔      ✔      —     createSpv/updateSpv still client-side (admin page)
--   spv_issuances            ✔      ✔*     —      —     recordIssuance client-side; 0027 trigger + *insert forbids cap_override
--   passport_requests        (policies live in 0028 — it CREATES the table; 0025 must not reference it, see note)
--   notifications            ✔      ✔      —      —     admin/notifications page still inserts client-side
--   integrations             ✔      —      ✔      —     admin/integrations status updates client-side
--   jurisdictions            ✔      ✔      ✔      —     admin/jurisdictions create/update client-side
--   documents (table)        ✔      ✔      ✔      —     admin/documents create + publish/unpublish client-side
--   fee_config               ✔      ✔      ✔      ✔     admin fees CRUD entirely client-side (unchanged — flagged)
--   fee_waivers              ✔      ✔      ✔      ✔     same
--   compliance_alerts        ✔      ✔      ✔      —     admin compliance create/resolve client-side (unchanged)
--   vesting_schedules        ✔      ✔      ✔      —     rights/builder insert + issuer status update client-side
--   vesting_milestones       ✔      ✔      ✔      —     builder insert + publish flag client-side
--   vesting_beneficiaries    ✔      ✔      —      —     builder insert client-side
--   vesting_claims           ✔      —      —      —     read-only client-side
--
-- Storage:
--   bucket 'client-documents'  PRIVATE, service-role only (upload route + 60-min signed URLs) — no anon policies
--   bucket 'documents'         keep public read; KEEP anon insert (WhitepaperCard + admin/documents still upload
--                              via anon storage API — revoking breaks whitepaper upload until an upload route
--                              exists); revoke anon update/delete (objects become immutable to the anon key).

-- ---------------------------------------------------------------------------
-- 1. Drop every existing policy on the governed public tables
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
        'launch_applications', 'application_events', 'launch_listings',
        'launch_updates', 'commitments',
        'delivery_requests', 'resell_listings', 'otc_requests',
        'custom_inquiries',
        'audit_events',
        'payouts', 'payout_recipients',
        'asset_profiles', 'issuer_profiles',
        'spvs', 'spv_issuances',
        -- passport_requests is created in 0028 (which runs AFTER this file in
        -- numeric order) — referencing it here would fail with "relation does
        -- not exist" and roll back the whole lockdown. Its RLS is set up in 0028.
        'notifications', 'integrations',
        'jurisdictions', 'documents',
        'fee_config', 'fee_waivers',
        'compliance_alerts',
        'vesting_schedules', 'vesting_milestones', 'vesting_beneficiaries',
        'vesting_claims'
      )
  loop
    execute format('drop policy %I on public.%I', pol.policyname, pol.tablename);
  end loop;
end $$;

-- Ensure RLS is on everywhere (idempotent; all were enabled by earlier
-- migrations, this is belt-and-braces for fresh installs).
alter table public.clients               enable row level security;
alter table public.client_notes          enable row level security;
alter table public.client_documents      enable row level security;
alter table public.kyc_requirements      enable row level security;
alter table public.tos_acceptances       enable row level security;
alter table public.launch_applications   enable row level security;
alter table public.application_events    enable row level security;
alter table public.launch_listings       enable row level security;
alter table public.launch_updates        enable row level security;
alter table public.commitments           enable row level security;
alter table public.delivery_requests     enable row level security;
alter table public.resell_listings       enable row level security;
alter table public.otc_requests          enable row level security;
alter table public.custom_inquiries      enable row level security;
alter table public.audit_events          enable row level security;
alter table public.payouts               enable row level security;
alter table public.payout_recipients     enable row level security;
alter table public.asset_profiles        enable row level security;
alter table public.issuer_profiles       enable row level security;
alter table public.spvs                  enable row level security;
alter table public.spv_issuances         enable row level security;
-- passport_requests: RLS enabled + policies in 0028 (created there; 0028 runs
-- after this file — do NOT reference the table here or the migration fails).
alter table public.notifications         enable row level security;
alter table public.integrations          enable row level security;
alter table public.jurisdictions         enable row level security;
alter table public.documents             enable row level security;
alter table public.fee_config            enable row level security;
alter table public.fee_waivers           enable row level security;
alter table public.compliance_alerts     enable row level security;
alter table public.vesting_schedules     enable row level security;
alter table public.vesting_milestones    enable row level security;
alter table public.vesting_beneficiaries enable row level security;
alter table public.vesting_claims        enable row level security;

-- ---------------------------------------------------------------------------
-- 2. SELECT-only tables — all writes go through service-role routes
-- ---------------------------------------------------------------------------

-- SD1: routes own all writes. Anon may read client rows (admin directory,
-- findClientByWallet gate), but NEVER the magic-link bearer secret
-- clients.onboarding_token — a world-readable token would let any anon-key
-- holder harvest tokens and hijack unlinked onboarding identities (link a
-- wallet, accept ToS, upload KYC docs as the invitee). The onboarding page now
-- validates its token SERVER-SIDE (/api/clients/onboarding-view) and
-- lib/clients.ts selects an explicit column list; the column grant below makes
-- onboarding_token unreadable by the anon role.
--
-- NOTE: a bare `revoke select (onboarding_token) ... from anon` is a NO-OP while
-- anon holds table-level SELECT (Postgres: a table-wide privilege covers every
-- column). So we drop the table-level grant and re-grant SELECT on every column
-- EXCEPT onboarding_token. RLS still governs which ROWS are visible.
-- Maintenance: a NEW clients column must be added to this grant or it will be
-- invisible to the anon role.
create policy "clients anon read"
  on public.clients for select using (true);
revoke select on public.clients from anon;
grant select (
  id, created_at, updated_at, network, type, tier, tags, source, email,
  display_name, company_name, jurisdiction, kyc_status, kyc_provider,
  kyc_provider_ref, kyc_verified_at, kyc_expires_at, onboarding_status, wallet,
  issuer_pda, suspended_at, notes_count, last_activity_at, types,
  tos_accepted_at, tos_version
) on public.clients to anon;

create policy "client_notes anon read"
  on public.client_notes for select using (true);

-- Metadata only — the document bytes moved to the private bucket.
create policy "client_documents anon read"
  on public.client_documents for select using (true);

create policy "kyc_requirements anon read"
  on public.kyc_requirements for select using (true);

-- lib/tos.ts checks (wallet, version) client-side; accepts go through
-- /api/tos/accept (signed).
create policy "tos_acceptances anon read"
  on public.tos_acceptances for select using (true);

-- SD2: /apply reads own applications by wallet, admin queue lists all.
create policy "launch_applications anon read"
  on public.launch_applications for select using (true);

create policy "application_events anon read"
  on public.application_events for select using (true);

create policy "launch_updates anon read"
  on public.launch_updates for select using (true);

-- SD3: holder portfolio + admin custody read directly.
create policy "delivery_requests anon read"
  on public.delivery_requests for select using (true);

-- Full SELECT (not status='active' scoped): the admin resell board lists all
-- statuses through the same anon client.
create policy "resell_listings anon read"
  on public.resell_listings for select using (true);

create policy "otc_requests anon read"
  on public.otc_requests for select using (true);

-- custom_inquiries: NO anon policies at all — create/list/update are fully
-- route-backed (SD4). Default-deny.

-- Insert moved to /api/audit; admin/audit + admin/health still read directly.
create policy "audit_events anon read"
  on public.audit_events for select using (true);

-- Full SELECT: admin + issuer UIs list DRAFT profiles through the anon
-- client; an is_published-scoped policy would hide them. Writes are
-- route-backed (/api/profiles/upsert) with server-enforced SSC field rules.
create policy "asset_profiles anon read"
  on public.asset_profiles for select using (true);

create policy "vesting_claims anon read"
  on public.vesting_claims for select using (true);

-- ---------------------------------------------------------------------------
-- 3. Tables with residual client-side anon WRITES (not moved in P1).
--    Each verb below is load-bearing for a live flow; tightening any of them
--    requires moving the corresponding write behind a route first.
-- ---------------------------------------------------------------------------

-- lib/launchpad.ts upsertListing (insert+update via upsert).
create policy "launch_listings anon read"
  on public.launch_listings for select using (true);
create policy "launch_listings anon insert"
  on public.launch_listings for insert with check (true);
create policy "launch_listings anon update"
  on public.launch_listings for update using (true) with check (true);

-- lib/launchpad.ts recordCommitment / settleCommitment.
create policy "commitments anon read"
  on public.commitments for select using (true);
create policy "commitments anon insert"
  on public.commitments for insert with check (true);
create policy "commitments anon update"
  on public.commitments for update using (true) with check (true);

-- payouts / payout_recipients: ALL writes route-backed (create modal switched
-- to createPayout() by W3-SWEEP; [id] page was already route-backed).
-- Reads stay client-side (admin list + detail pages).
create policy "payouts anon read"
  on public.payouts for select using (true);
create policy "payout_recipients anon read"
  on public.payout_recipients for select using (true);

-- lib/issuer-profiles.ts upsertIssuerProfile still client-side.
create policy "issuer_profiles anon read"
  on public.issuer_profiles for select using (true);
create policy "issuer_profiles anon insert"
  on public.issuer_profiles for insert with check (true);
create policy "issuer_profiles anon update"
  on public.issuer_profiles for update using (true) with check (true);

-- lib/spvs.ts createSpv / updateSpv (admin page) still client-side.
-- annual_cap_eur must NOT be anon-updatable: raising it would defeat the 0027
-- EUR-3M cap trigger (which reads spvs.annual_cap_eur live) just as
-- cap_override does. updateSpv only ever patches the 8 editable columns below,
-- so lock the column-level UPDATE grant to exactly those — anon can no longer
-- touch annual_cap_eur (or id/created_at/network). createSpv still sets the
-- initial cap on INSERT (a separate, unchanged privilege).
create policy "spvs anon read"
  on public.spvs for select using (true);
create policy "spvs anon insert"
  on public.spvs for insert with check (true);
create policy "spvs anon update"
  on public.spvs for update using (true) with check (true);
revoke update on public.spvs from anon;
grant update (
  name, registration_number, country, status, client_id, issuer_pda,
  incorporated_at, notes
) on public.spvs to anon;

-- lib/spvs.ts recordIssuance / recordSaleIssuance still client-side; the
-- 0027 BEFORE INSERT trigger enforces the EUR 3M cap. The trigger EARLY-RETURNS
-- on cap_override=true, so an anon insert must NOT be allowed to set it — the
-- super-admin override is a client-side-only gate any anon-key holder could
-- forge. `with check (cap_override = false)` forces overrides through a
-- (future) signed requireSuperAdmin route; the normal capped insert (default
-- cap_override=false) is unaffected. Fail-safe: the cap stays enforced.
-- Fresh installations reach this policy before 0027 adds cap_override.
-- Create the same idempotent column now; 0027 installs its enforcement trigger.
alter table public.spv_issuances
  add column if not exists cap_override boolean not null default false;
create policy "spv_issuances anon read"
  on public.spv_issuances for select using (true);
create policy "spv_issuances anon insert"
  on public.spv_issuances for insert with check (cap_override = false);

-- passport_requests policies are defined in 0028 (which CREATES the table).
-- 0025 must not touch passport_requests: it runs BEFORE 0028 in numeric order,
-- so any reference here fails with "relation does not exist" and rolls back the
-- entire lockdown. See 0028 for the anon read/insert/update matrix.

-- admin/notifications composes rows client-side; SD3's OTC route also writes
-- via service role (unaffected).
create policy "notifications anon read"
  on public.notifications for select using (true);
create policy "notifications anon insert"
  on public.notifications for insert with check (true);

-- admin/integrations toggles status client-side; no client insert exists.
create policy "integrations anon read"
  on public.integrations for select using (true);
create policy "integrations anon update"
  on public.integrations for update using (true) with check (true);

-- admin/jurisdictions create + edit client-side; DELETE dropped (unused).
create policy "jurisdictions anon read"
  on public.jurisdictions for select using (true);
create policy "jurisdictions anon insert"
  on public.jurisdictions for insert with check (true);
create policy "jurisdictions anon update"
  on public.jurisdictions for update using (true) with check (true);

-- documents TABLE (metadata ledger): admin/documents inserts + publishes
-- client-side; DELETE dropped (unused).
create policy "documents anon read"
  on public.documents for select using (true);
create policy "documents anon insert"
  on public.documents for insert with check (true);
create policy "documents anon update"
  on public.documents for update using (true) with check (true);

-- Fees admin CRUD is entirely client-side (incl. delete buttons) — recreated
-- unchanged. FLAGGED: highest-residual-risk tables; needs a route follow-up.
create policy "fee_config anon read"
  on public.fee_config for select using (true);
create policy "fee_config anon insert"
  on public.fee_config for insert with check (true);
create policy "fee_config anon update"
  on public.fee_config for update using (true) with check (true);
create policy "fee_config anon delete"
  on public.fee_config for delete using (true);

create policy "fee_waivers anon read"
  on public.fee_waivers for select using (true);
create policy "fee_waivers anon insert"
  on public.fee_waivers for insert with check (true);
create policy "fee_waivers anon update"
  on public.fee_waivers for update using (true) with check (true);
create policy "fee_waivers anon delete"
  on public.fee_waivers for delete using (true);

-- Compliance alerts: raise + resolve client-side (unchanged verbs, no delete).
create policy "compliance_alerts anon read"
  on public.compliance_alerts for select using (true);
create policy "compliance_alerts anon insert"
  on public.compliance_alerts for insert with check (true);
create policy "compliance_alerts anon update"
  on public.compliance_alerts for update using (true) with check (true);

-- Vesting: rights/builder inserts schedules/milestones/beneficiaries; issuer
-- page updates schedule status + milestone published flag. DELETEs dropped.
create policy "vesting_schedules anon read"
  on public.vesting_schedules for select using (true);
create policy "vesting_schedules anon insert"
  on public.vesting_schedules for insert with check (true);
create policy "vesting_schedules anon update"
  on public.vesting_schedules for update using (true) with check (true);

create policy "vesting_milestones anon read"
  on public.vesting_milestones for select using (true);
create policy "vesting_milestones anon insert"
  on public.vesting_milestones for insert with check (true);
create policy "vesting_milestones anon update"
  on public.vesting_milestones for update using (true) with check (true);

create policy "vesting_beneficiaries anon read"
  on public.vesting_beneficiaries for select using (true);
create policy "vesting_beneficiaries anon insert"
  on public.vesting_beneficiaries for insert with check (true);

-- ---------------------------------------------------------------------------
-- 4. Storage
-- ---------------------------------------------------------------------------

-- Private KYC bucket (SD1): all access via service role — upload route
-- app/api/clients/upload + 60-min signed URLs from /api/clients/doc-url.
-- Service role bypasses RLS, so NO storage.objects policies are created for
-- this bucket: anon/authenticated get default-deny.
insert into storage.buckets (id, name, public)
values ('client-documents', 'client-documents', false)
on conflict (id) do nothing;

-- Public 'documents' bucket: keep public read (whitepapers / legal docs /
-- marketing PDFs). KEEP anon insert — components/asset-detail.tsx
-- (whitepaper + SSC decision doc upload) and app/admin/documents/page.tsx
-- still upload through the anon storage API; revoking INSERT before those
-- move behind a route breaks whitepaper upload (SD4 note). Revoke anon delete
-- (objects become immutable to the anon key).
--
-- anon UPDATE is NOT fully revoked: asset-detail uploads with `upsert:true`
-- (content-addressed paths under whitepapers/), and a Supabase upsert of an
-- EXISTING object is an UPDATE on storage.objects — dropping the update policy
-- would 403 the re-save of an already-uploaded whitepaper / SSC doc. So keep a
-- NARROW update policy scoped to the whitepapers/ prefix only. admin/documents
-- uses `upsert:false` with version-numbered paths, so it needs no UPDATE.
drop policy if exists "documents anon delete" on storage.objects;

drop policy if exists "documents anon update" on storage.objects;
create policy "documents anon update"
  on storage.objects for update
  using (bucket_id = 'documents' and name like 'whitepapers/%')
  with check (bucket_id = 'documents' and name like 'whitepapers/%');

-- Recreate read/insert defensively (no-ops if 0011's versions still exist).
drop policy if exists "documents public read" on storage.objects;
create policy "documents public read"
  on storage.objects for select
  using (bucket_id = 'documents');

drop policy if exists "documents anon write" on storage.objects;
create policy "documents anon write"
  on storage.objects for insert
  with check (bucket_id = 'documents');

-- Bound abuse of the still-anon-writable public bucket: cap object size so it
-- can't be used as an unlimited free CDN for large payloads. NOTE: this is a
-- PARTIAL mitigation — arbitrary same-size files can still be hosted. Fully
-- closing the arbitrary-hosting hole needs a signed upload route (admin for SSC
-- docs, admin-or-issuer for whitepapers) + dropping anon INSERT; deferred
-- because BOTH asset-detail and admin/documents still use the anon storage API.
-- (No allowed_mime_types allowlist here: the admin doc library accepts varied
-- document types and a wrong guess would 403 legit uploads on a live bucket.)
update storage.buckets
  set file_size_limit = 26214400 -- 25 MiB
  where id = 'documents';
