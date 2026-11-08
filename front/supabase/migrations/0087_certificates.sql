-- 0087: certificates of tokenized interest (owner's P1, 2026-11-08).
--
-- On 2026-10-04 a "confirmation for state authorities" was made by hand: a
-- PDF describing a tokenized company interest, signed with the operator's
-- Ed25519 wallet key. This is the product version. An admin issues a
-- numbered certificate stating on-chain facts about a share class (kind
-- 'issuance') or about the units a wallet holds of it (kind 'holding'):
--
--   * the payload is canonical JSON (front/lib/certificates/canonical.ts,
--     schema manci.certificate.v1), built by the server from the chain and
--     the admin's corrections;
--   * the admin's wallet signs "Manci certificate v1\nNumber: <number>\n
--     SHA-256: <hash>"; the server verifies the Ed25519 signature before it
--     stores it (POST /api/admin/certificates/sign);
--   * the Super Admin anchors "<number> sha256:<hash>" in a Memo through the
--     document-anchor flow; the certificate takes the anchor only once the
--     anchor route recorded it as finalized (/api/admin/certificates/anchor);
--   * anyone checks a certificate by its number on /certificates/verify,
--     which never shows the holder's name or ID number.
--
-- certificates: one row per certificate. The number is unique per network
-- and comes from allocate_certificate_number() (a yearly counter per
-- network: MC-2026-0001, MC-2026-0002, ...). A failure between the
-- allocation and the insert skips a number; a number is never given twice.
-- payload_canonical holds the exact bytes that were hashed, and the CHECKs
-- keep payload_sha256 = sha256(payload_canonical) and every column equal to
-- what the payload itself says (number, kind, network, signer, asset, share
-- class, holder wallet), so a row can never state something its signed
-- payload does not. Lifecycle (certificates_guard): a row is born a draft;
-- draft -> signed -> anchored, and any -> revoked with a reason; revoked is
-- final. Nothing that was signed changes after the signature, an anchor
-- never changes once set, the database stamps the time of every move, and
-- only a draft may be deleted.
--
-- The payload may hold personal data (a holder's name and identification
-- number, typed by the admin for one certificate): RLS on and no grant to
-- anon or authenticated. The service role reads and writes the rows through
-- the admin routes (requireAdmin); the public route selects the columns it
-- needs and returns a projection without them (lib/certificates/payload.ts
-- publicCertificateView).
--
-- certificate_counters: the per-network yearly counter, written only by the
-- SECURITY DEFINER allocator; no API role may read or write it directly.
--
-- Expand-only: the front reads these tables only from the certificate
-- routes and pages, which answer 503 until the migration is applied.
begin;
set local lock_timeout = '15s';

create table if not exists public.certificate_counters (
  network text not null default public.deployment_network()
    check (network in ('mainnet', 'devnet', 'testnet', 'localnet')),
  year integer not null check (year between 2026 and 9999),
  last_value integer not null check (last_value between 1 and 999999),
  primary key (network, year)
);
alter table public.certificate_counters enable row level security;
revoke all on public.certificate_counters from public, anon, authenticated, service_role;

create table if not exists public.certificates (
  id uuid primary key default gen_random_uuid(),
  network text not null default public.deployment_network()
    check (network in ('mainnet', 'devnet', 'testnet', 'localnet')),
  number text not null check (number ~ '^MC-[0-9]{4}-[0-9]{4,6}$'),
  kind text not null check (kind in ('holding', 'issuance')),
  status text not null default 'draft' check (status in ('draft', 'signed', 'anchored', 'revoked')),
  asset_pda text not null check (asset_pda ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  share_class_pda text not null check (share_class_pda ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  holder_wallet text check (holder_wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  payload_canonical text not null check (length(payload_canonical) between 2 and 32768),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  signer text not null check (signer ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  signature text check (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  signature_format text check (signature_format in ('raw', 'offchain-v0', 'offchain-v0-legacy')),
  signed_at timestamptz,
  anchor_tx text check (anchor_tx ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  anchor_slot bigint check (anchor_slot >= 0),
  anchor_block_time timestamptz,
  anchored_at timestamptz,
  revoked_at timestamptz,
  revoked_by text check (revoked_by ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  revoke_reason text check (length(btrim(revoke_reason)) between 4 and 500),
  created_by text not null check (created_by ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint certificates_number_unique unique (network, number),
  -- The hash is the hash of exactly these bytes.
  constraint certificates_payload_hash check (
    payload_sha256 = encode(sha256(convert_to(payload_canonical, 'UTF8')), 'hex')
  ),
  -- The columns say what the payload says.
  constraint certificates_payload_columns check (
    jsonb_typeof(payload_canonical::jsonb) = 'object'
    and payload_canonical::jsonb ->> 'schema' = 'manci.certificate.v1'
    and payload_canonical::jsonb ->> 'number' = number
    and payload_canonical::jsonb ->> 'kind' = kind
    and payload_canonical::jsonb ->> 'network' = network
    and payload_canonical::jsonb -> 'signer' ->> 'public_key' = signer
    and payload_canonical::jsonb -> 'asset' ->> 'asset_pda' = asset_pda
    and payload_canonical::jsonb -> 'share_class' ->> 'share_class_pda' = share_class_pda
    and (payload_canonical::jsonb -> 'holder' ->> 'wallet') is not distinct from holder_wallet
  ),
  -- A holding names its wallet; an issuance names none.
  constraint certificates_kind_holder check ((kind = 'holding') = (holder_wallet is not null)),
  -- The signature, its format and its time come together; an anchor only after a signature.
  constraint certificates_signature_fields check (
    (signature is null) = (signature_format is null) and (signature is null) = (signed_at is null)
  ),
  constraint certificates_anchor_fields check (
    (anchor_tx is null) = (anchored_at is null)
    and (anchor_tx is not null or (anchor_slot is null and anchor_block_time is null))
    and (anchor_tx is null or signature is not null)
  ),
  constraint certificates_revocation_fields check (
    (status = 'revoked') = (revoked_at is not null)
    and (revoked_at is null) = (revoked_by is null)
    and (revoked_at is null) = (revoke_reason is null)
  ),
  -- Each live status carries exactly its evidence (a revoked row keeps what it had).
  constraint certificates_status_evidence check (
    status = 'revoked'
    or (status = 'draft' and signature is null and anchor_tx is null)
    or (status = 'signed' and signature is not null and anchor_tx is null)
    or (status = 'anchored' and signature is not null and anchor_tx is not null)
  )
);
create index if not exists certificates_network_created_idx
  on public.certificates (network, created_at desc);
create index if not exists certificates_asset_idx
  on public.certificates (network, asset_pda, created_at desc);
alter table public.certificates enable row level security;
revoke all on public.certificates from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.certificates to service_role;

-- The lifecycle. Moves: draft -> signed | revoked, signed -> anchored |
-- revoked, anchored -> revoked; nothing else (no update that keeps the
-- status, no way out of revoked). The database stamps signed_at,
-- anchored_at and revoked_at, and updated_at strictly increases.
create or replace function public.certificates_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'A certificate is created as a draft' using errcode = '23514';
    end if;
    new.created_at := pg_catalog.clock_timestamp();
    new.updated_at := new.created_at;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Only a draft certificate can be deleted (this one is %)', old.status using errcode = '23514';
    end if;
    return old;
  end if;

  if new.id <> old.id or new.network <> old.network or new.number <> old.number or new.kind <> old.kind
     or new.created_by <> old.created_by or new.created_at <> old.created_at then
    raise exception 'A certificate''s identity is immutable' using errcode = '23514';
  end if;
  if old.status = 'revoked' then
    raise exception 'A revoked certificate is final' using errcode = '23514';
  end if;
  if not ((old.status = 'draft' and new.status in ('signed', 'revoked'))
       or (old.status = 'signed' and new.status in ('anchored', 'revoked'))
       or (old.status = 'anchored' and new.status = 'revoked')) then
    raise exception 'A certificate cannot move from % to %', old.status, new.status using errcode = '23514';
  end if;

  -- The payload never changes: a draft is signed as it was created, and the
  -- signature covers the hash of exactly these bytes.
  if new.payload_canonical is distinct from old.payload_canonical
     or new.payload_sha256 is distinct from old.payload_sha256
     or new.signer is distinct from old.signer
     or new.asset_pda is distinct from old.asset_pda
     or new.share_class_pda is distinct from old.share_class_pda
     or new.holder_wallet is distinct from old.holder_wallet then
    raise exception 'A certificate''s payload is immutable' using errcode = '23514';
  end if;

  if old.status = 'draft' and new.status = 'signed' then
    if new.signature is null or new.signature_format is null then
      raise exception 'Signing a certificate needs its signature' using errcode = '23514';
    end if;
    new.signed_at := pg_catalog.clock_timestamp();
  elsif new.signature is distinct from old.signature
     or new.signature_format is distinct from old.signature_format
     or new.signed_at is distinct from old.signed_at then
    raise exception 'A certificate''s signature never changes' using errcode = '23514';
  end if;

  if old.status = 'signed' and new.status = 'anchored' then
    if new.anchor_tx is null then
      raise exception 'Anchoring a certificate needs the anchor transaction' using errcode = '23514';
    end if;
    new.anchored_at := pg_catalog.clock_timestamp();
  elsif new.anchor_tx is distinct from old.anchor_tx
     or new.anchor_slot is distinct from old.anchor_slot
     or new.anchor_block_time is distinct from old.anchor_block_time
     or new.anchored_at is distinct from old.anchored_at then
    raise exception 'A certificate''s anchor never changes' using errcode = '23514';
  end if;

  if new.status = 'revoked' then
    if new.revoked_by is null or new.revoke_reason is null then
      raise exception 'Revoking a certificate needs who and why' using errcode = '23514';
    end if;
    new.revoked_at := pg_catalog.clock_timestamp();
  end if;

  new.updated_at := greatest(pg_catalog.clock_timestamp(), old.updated_at + interval '1 microsecond');
  return new;
end;
$$;
revoke all on function public.certificates_guard() from public, anon, authenticated, service_role;
drop trigger if exists certificates_guard on public.certificates;
create trigger certificates_guard before insert or update or delete on public.certificates
  for each row execute function public.certificates_guard();

-- The next number of `p_year` on this project's network: "MC-<year>-0001",
-- four digits at least (more past 9999). One statement takes the counter's
-- row lock, so concurrent callers get consecutive, distinct numbers. The
-- year is the server's UTC year of the certificate's issued_at; the database
-- accepts it only within a year of its own UTC clock.
create or replace function public.allocate_certificate_number(p_year integer)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_this_year integer := extract(year from (pg_catalog.clock_timestamp() at time zone 'UTC'))::integer;
  v_value integer;
begin
  if p_year is null or p_year not between 2026 and 9999 or abs(p_year - v_this_year) > 1 then
    raise exception 'Invalid certificate year %', p_year using errcode = '22023';
  end if;
  insert into public.certificate_counters as c (network, year, last_value)
    values (public.deployment_network(), p_year, 1)
    on conflict (network, year) do update set last_value = c.last_value + 1
    returning c.last_value into v_value;
  return 'MC-' || p_year::text || '-'
    || case when v_value < 10000 then pg_catalog.lpad(v_value::text, 4, '0') else v_value::text end;
end;
$$;
revoke all on function public.allocate_certificate_number(integer) from public, anon, authenticated, service_role;
grant execute on function public.allocate_certificate_number(integer) to service_role;

comment on table public.certificates is
  'Certificates of tokenized interest (0087): canonical payload, its SHA-256, the admin wallet''s signature and the on-chain anchor. May hold personal data; service role only.';
comment on table public.certificate_counters is
  'Per-network yearly certificate counter (0087), written only by allocate_certificate_number().';

select mancipatio_ops.install_network_guards();

commit;
