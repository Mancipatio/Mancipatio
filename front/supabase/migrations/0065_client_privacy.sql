-- 0065: client privacy — erasure-safe Terms ledger and dossier anonymization.
--
-- 1. tos_acceptances.client_id: ON DELETE CASCADE -> ON DELETE SET NULL.
--    A Terms acceptance is the record of consent. It must outlive the dossier
--    it was linked to; losing a dossier row (by any path) now detaches the
--    acceptance instead of deleting it. The application itself never deletes
--    clients rows — erasure is anonymize_client() below.
--
-- 2. One acceptance per (wallet, version). /api/tos/accept checked before it
--    inserted (a race could still write two rows) and the onboarding route
--    /api/clients/accept-tos appended without checking, so duplicates can
--    exist. Before the unique index is built, every later duplicate is COPIED
--    to tos_acceptance_duplicates (with the id of the row that stays) and then
--    removed; the earliest acceptance stays, and inherits a dossier link a
--    later duplicate carried when it had none. Nothing is lost: the archive
--    holds each removed row verbatim. Rows without a wallet (wallet-less
--    account dossiers) are not constrained (NULLs are distinct).
--    The routes now treat a unique violation (23505) as "already accepted".
--
-- 3. clients.anonymized_at — when the dossier's personal data was last erased.
--
-- 4. public.anonymize_client(client_id, network, actor, dry_run) — service
--    role only.
--    One transaction that erases a dossier's personal data and keeps the
--    records the platform needs:
--      erased   client_documents rows (identity documents — the route deletes
--               the files in the client-documents bucket), every
--               client_verification_details row, the text of client_notes,
--               kyc_requirements notes and document links, passport_requests
--               notes, the client_raise_limits note, and the clients fields
--               email, display_name, company_name, jurisdiction, tags,
--               source, kyc_provider_ref and the onboarding token.
--      kept     the clients row itself (id, network, type, wallet, account,
--               KYC dates and verdict history), tos_acceptances (detached:
--               client_id -> NULL), requirement checklist statuses, note
--               timestamps/authors, delivery and conversion requests,
--               compliance alerts and audit_events.
--    The verdict ends: kyc_status becomes 'expired' and kyc_expires_at is
--    capped at now, so an erased dossier can no longer pass the conversion /
--    delivery KYC gate. A 'suspended' or 'rejected' verdict is kept as is so
--    the wallet stays blocked from reapplying. It refuses while a conversion
--    or delivery request of the dossier is still in flight. It never deletes
--    the clients row and never cascades. Re-running it is safe: it erases
--    whatever was added since and moves anonymized_at forward.
--
-- Deploy order: either. The matching front degrades without it (the admin
-- page omits the marker, the export skips the archive, Anonymize answers 503
-- before touching anything) and the ToS routes only see 23505 once it is
-- applied. Re-applying is harmless.
begin;

-- Nothing may read or write acceptances while the ledger is deduplicated and
-- the constraint and index are rebuilt. Taken up front (not upgraded midway)
-- so it cannot deadlock; the table is small, so the lock is short.
lock table public.tos_acceptances in access exclusive mode;

-- 1. Foreign key: detach, never delete. Drops whatever name the FK has.
do $$
declare con record;
begin
  for con in
    select conname from pg_constraint
     where conrelid = 'public.tos_acceptances'::regclass
       and contype = 'f'
       and confrelid = 'public.clients'::regclass
  loop
    execute format('alter table public.tos_acceptances drop constraint %I', con.conname);
  end loop;
end $$;
alter table public.tos_acceptances
  add constraint tos_acceptances_client_id_fkey
  foreign key (client_id) references public.clients(id) on delete set null;

-- 2. Deduplicate, keeping every removed row in an archive.
create table if not exists public.tos_acceptance_duplicates (
  -- The removed row's original tos_acceptances.id.
  id bigint primary key,
  created_at timestamptz not null,
  -- No foreign key: the archive outlives dossiers; anonymize_client detaches.
  client_id uuid,
  wallet text,
  version text not null,
  source text not null,
  -- The acceptance that stayed in tos_acceptances for (wallet, version).
  kept_id bigint not null,
  archived_at timestamptz not null default now()
);
alter table public.tos_acceptance_duplicates enable row level security;
revoke all on public.tos_acceptance_duplicates from public, anon, authenticated;
grant all on public.tos_acceptance_duplicates to service_role;

with ranked as (
  select id,
         first_value(id) over w as kept_id,
         row_number() over w as rn
    from public.tos_acceptances
   where wallet is not null
  window w as (partition by wallet, version order by created_at, id)
)
insert into public.tos_acceptance_duplicates
  (id, created_at, client_id, wallet, version, source, kept_id, archived_at)
select t.id, t.created_at, t.client_id, t.wallet, t.version, t.source, r.kept_id, now()
  from ranked r
  join public.tos_acceptances t on t.id = r.id
 where r.rn > 1
on conflict (id) do nothing;

-- The earliest acceptance inherits the oldest dossier link one of its
-- duplicates archived in THIS run carried, when it has none itself.
update public.tos_acceptances k
   set client_id = d.client_id
  from (
    select distinct on (kept_id) kept_id, client_id
      from public.tos_acceptance_duplicates
     where client_id is not null and archived_at = now()
     order by kept_id, created_at, id
  ) d
 where k.id = d.kept_id
   and k.client_id is null
   and exists (select 1 from public.clients c where c.id = d.client_id);

delete from public.tos_acceptances t
 using public.tos_acceptance_duplicates d
 where d.id = t.id;

create unique index if not exists tos_acceptances_wallet_version_key
  on public.tos_acceptances (wallet, version);
-- The unique index serves the same (wallet, version) lookups.
drop index if exists public.tos_acceptances_wallet_version_idx;

-- 3. Erasure marker.
alter table public.clients add column if not exists anonymized_at timestamptz;
comment on column public.clients.anonymized_at is
  'When anonymize_client() last erased this dossier''s personal data (NULL = never).';

-- 4. Erasure.
-- p_dry_run = true runs every check and changes nothing ({"status":"ready"}):
-- the route calls it before deleting any file, so a refusal (or a database
-- without this function) never leaves files deleted and rows untouched.
drop function if exists public.anonymize_client(uuid, text, text);
create or replace function public.anonymize_client(
  p_client_id uuid, p_network text, p_actor text, p_dry_run boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.clients%rowtype;
  v_now timestamptz := clock_timestamp();
  v_paths text[];
  n_documents integer := 0;
  n_details integer := 0;
  n_notes integer := 0;
  n_requirements integer := 0;
  n_tos integer := 0;
  n_tos_archived integer := 0;
  n_passport integer := 0;
  -- The timeline entry this function leaves; a re-run keeps it.
  c_marker constant text :=
    'Personal data erased: identity documents and verification details deleted, notes cleared. Ledger records kept.';
begin
  if p_client_id is null
     or p_network is null or p_network not in ('devnet', 'mainnet', 'testnet', 'localnet')
     or p_actor is null or p_actor !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' then
    raise exception 'anonymize_client: invalid arguments' using errcode = '22023';
  end if;

  select * into c from public.clients
   where id = p_client_id and network = p_network
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- An in-flight conversion or delivery still needs its dossier.
  if exists (
    select 1 from public.conversion_requests r
     where r.network = p_network
       and (r.client_id = p_client_id or (c.wallet is not null and r.holder_wallet = c.wallet))
       and r.status not in ('converted', 'cancelled', 'returned')
  ) or exists (
    select 1 from public.delivery_requests r
     where r.network = p_network
       and (r.client_id = p_client_id or (c.wallet is not null and r.holder_wallet = c.wallet))
       and r.status not in ('delivered', 'cancelled', 'returned')
  ) then
    return jsonb_build_object('status', 'active_requests');
  end if;
  if coalesce(p_dry_run, false) then
    return jsonb_build_object('status', 'ready', 'anonymized_at', c.anonymized_at);
  end if;

  -- Checklist history stays; its free text and document links go.
  update public.kyc_requirements
     set document_id = null, note = null, updated_at = v_now
   where client_id = p_client_id and (document_id is not null or note is not null);
  get diagnostics n_requirements = row_count;

  -- Identity documents. The route deleted the stored files before calling
  -- this and deletes any path returned here that it had not seen.
  with gone as (
    delete from public.client_documents where client_id = p_client_id
    returning storage_path
  )
  select coalesce(array_agg(storage_path order by storage_path), '{}'::text[]), count(*)
    into v_paths, n_documents
    from gone;

  delete from public.client_verification_details where client_id = p_client_id;
  get diagnostics n_details = row_count;

  update public.client_notes set body = '[erased]'
   where client_id = p_client_id and body <> '[erased]'
     and not (kind = 'system' and body = c_marker);
  get diagnostics n_notes = row_count;

  update public.client_raise_limits set note = null
   where client_id = p_client_id and note is not null;

  -- Consent records stay, detached from the erased dossier.
  update public.tos_acceptances set client_id = null where client_id = p_client_id;
  get diagnostics n_tos = row_count;
  update public.tos_acceptance_duplicates set client_id = null where client_id = p_client_id;
  get diagnostics n_tos_archived = row_count;

  if c.wallet is not null then
    update public.passport_requests set note = null
     where wallet = c.wallet and note is not null;
    get diagnostics n_passport = row_count;
  end if;

  update public.clients set
    email = null,
    display_name = 'Anonymized client',
    company_name = null,
    jurisdiction = null,
    tags = '[]'::jsonb,
    source = null,
    kyc_provider_ref = null,
    onboarding_token = null,
    onboarding_token_expires_at = null,
    kyc_status = case when c.kyc_status in ('suspended', 'rejected') then c.kyc_status else 'expired' end,
    kyc_expires_at = case when c.kyc_expires_at is null then null else least(c.kyc_expires_at, v_now) end,
    anonymized_at = v_now,
    last_activity_at = v_now
   where id = p_client_id;

  insert into public.client_notes (client_id, author, body, kind)
  values (p_client_id, p_actor, c_marker, 'system');
  update public.clients
     set notes_count = (select count(*) from public.client_notes where client_id = p_client_id)
   where id = p_client_id;

  return jsonb_build_object(
    'status', 'anonymized',
    'anonymized_at', v_now,
    'storage_paths', to_jsonb(v_paths),
    'previous', jsonb_build_object(
      'kyc_status', c.kyc_status,
      'kyc_verified_at', c.kyc_verified_at,
      'kyc_expires_at', c.kyc_expires_at,
      'anonymized_at', c.anonymized_at),
    'counts', jsonb_build_object(
      'documents', n_documents,
      'verification_details', n_details,
      'notes_erased', n_notes,
      'requirements_cleared', n_requirements,
      'tos_detached', n_tos + n_tos_archived,
      'passport_request_notes', n_passport)
  );
end;
$$;
revoke all on function public.anonymize_client(uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.anonymize_client(uuid, text, text, boolean) to service_role;

commit;
