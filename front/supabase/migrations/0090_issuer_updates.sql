-- 0090: Investor relations — issuer updates, periodic reports and their
-- documents.
--
-- The authority of an on-chain Issuer writes updates for its token holders:
-- a draft it can edit, then a published record that never changes again,
-- except that it may be anchored on chain once (anchor_tx, the Memo
-- transaction the issuer key signed) and withdrawn with a reason, by the
-- issuer or, as moderation, by a platform admin. A withdrawn update stays in
-- the table (who, when, why) and is served to nobody but its issuer and the
-- admins. Only a draft can be deleted.
--
-- asset_pda NULL = the update concerns every asset of the issuer. visibility
-- 'holders' = served only to wallets that hold units of a share class of the
-- asset (or, for an issuer-wide update, of one of the issuer's assets); the
-- route checks the balance on chain and fails closed.
--
-- Documents are verified immutable versions (0048 document_versions) in the
-- PRIVATE bucket documents-confidential, at the content-addressed path
-- issuer-updates/<issuer_pda>/<network>/<sha256>/<file>: the upload route
-- authorizes only that issuer's authority, the finalize route hashes the
-- stored bytes, and the routes hand out short-lived signed URLs after
-- checking the update's status, visibility and, for holder updates, the
-- reader's balance. A withdrawal therefore cuts access to the files too.
-- A document can be attached to or removed from a draft only.
--
-- PRIVACY / RLS: default deny. No policies and no grants to anon or
-- authenticated; every read and write goes through the service-role routes
-- under /api/issuer-updates (signed, except the projection of published
-- public updates).
--
-- Re-runnable: create ... if not exists, create or replace, drop trigger if
-- exists. Expand-only: nothing existing changes.
begin;
set local lock_timeout = '15s';

create table if not exists public.issuer_updates (
  network text not null default public.deployment_network()
    check (network in ('mainnet', 'devnet', 'testnet', 'localnet')),
  id uuid primary key default gen_random_uuid(),
  issuer_pda text not null check (issuer_pda ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  asset_pda text check (asset_pda is null or asset_pda ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  kind text not null
    check (kind in ('update', 'quarterly_report', 'annual_report', 'financial_statement', 'notice')),
  -- The routes store trimmed text; these bound what any writer can store.
  title text not null
    check (char_length(title) <= 180 and btrim(title, E' \t') <> '' and title !~ '[[:cntrl:]]'),
  body text not null check (char_length(body) <= 20000 and btrim(body, E' \t\r\n') <> ''),
  period_label text check (period_label is null
    or (char_length(period_label) <= 40 and btrim(period_label, E' \t') <> '' and period_label !~ '[[:cntrl:]]')),
  visibility text not null default 'public' check (visibility in ('public', 'holders')),
  status text not null default 'draft' check (status in ('draft', 'published', 'withdrawn')),
  published_at timestamptz,
  published_by text,
  withdrawn_at timestamptz,
  withdrawn_by text,
  withdrawn_by_role text check (withdrawn_by_role is null or withdrawn_by_role in ('issuer', 'admin')),
  withdrawn_reason text check (withdrawn_reason is null
    or (char_length(withdrawn_reason) <= 500 and char_length(btrim(withdrawn_reason, E' \t\r\n')) >= 10)),
  anchor_tx text check (anchor_tx is null or anchor_tx ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  -- A report names its period ("Q3 2026", "FY 2025").
  check (kind not in ('quarterly_report', 'annual_report', 'financial_statement') or period_label is not null),
  -- Published and withdrawn rows carry their publication; a withdrawn row its withdrawal, whole.
  check ((status = 'draft') = (published_at is null) and (status = 'draft') = (published_by is null)),
  check ((status = 'withdrawn') = (withdrawn_at is not null)),
  check ((withdrawn_at is null) = (withdrawn_by is null)
     and (withdrawn_at is null) = (withdrawn_by_role is null)
     and (withdrawn_at is null) = (withdrawn_reason is null)),
  check (anchor_tx is null or status <> 'draft')
);
create index if not exists issuer_updates_issuer_idx
  on public.issuer_updates (network, issuer_pda, status, published_at desc);
create index if not exists issuer_updates_asset_idx
  on public.issuer_updates (network, asset_pda, status, published_at desc) where asset_pda is not null;
alter table public.issuer_updates enable row level security;
revoke all on public.issuer_updates from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.issuer_updates to service_role;

-- ---------------------------------------------------------------------------
-- Lifecycle guard (defense in depth under the routes).
--
--   insert              -> draft only
--   draft -> draft      content edits (scope, kind, title, body, period, visibility)
--   draft -> published  the saved draft exactly as it is; published_at is
--                       the database's clock, never the caller's
--   published           frozen: only anchor_tx, once (null -> signature), and
--   published -> withdrawn  with withdrawn_by / _role / _reason (withdrawn_at
--                       is the database's clock); nothing else in that statement
--   withdrawn           final
--   delete              drafts only
--
-- Identity (network, id, issuer_pda, created_by, created_at) never changes.
-- updated_at strictly increases on every write (the routes compare it, like
-- 0084), and the timestamps are the database's.
-- ---------------------------------------------------------------------------
create or replace function public.issuer_updates_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Only a draft update can be deleted; withdraw a published one' using errcode = '23514';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'A new update starts as a draft' using errcode = '23514';
    end if;
    new.created_at := pg_catalog.clock_timestamp();
    new.updated_at := new.created_at;
    return new;
  end if;

  if new.network is distinct from old.network or new.id is distinct from old.id
     or new.issuer_pda is distinct from old.issuer_pda or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'The identity of an update is immutable' using errcode = '23514';
  end if;

  if old.status = 'draft' then
    if new.status = 'published' then
      if (new.asset_pda, new.kind, new.title, new.body, new.period_label, new.visibility)
         is distinct from (old.asset_pda, old.kind, old.title, old.body, old.period_label, old.visibility) then
        raise exception 'Publish the saved draft as it is' using errcode = '23514';
      end if;
      new.published_at := pg_catalog.clock_timestamp();
    elsif new.status <> 'draft' then
      raise exception 'A draft is published or deleted, never withdrawn' using errcode = '23514';
    end if;
  elsif old.status = 'published' then
    if (new.asset_pda, new.kind, new.title, new.body, new.period_label, new.visibility,
        new.published_at, new.published_by, new.updated_by)
       is distinct from (old.asset_pda, old.kind, old.title, old.body, old.period_label, old.visibility,
        old.published_at, old.published_by, old.updated_by) then
      raise exception 'A published update cannot be edited; withdraw it instead' using errcode = '23514';
    end if;
    if new.anchor_tx is distinct from old.anchor_tx and old.anchor_tx is not null then
      raise exception 'An update is anchored once' using errcode = '23514';
    end if;
    if new.status = 'withdrawn' then
      if new.anchor_tx is distinct from old.anchor_tx then
        raise exception 'Withdraw and anchor in separate statements' using errcode = '23514';
      end if;
      new.withdrawn_at := pg_catalog.clock_timestamp();
    elsif new.status <> 'published' then
      raise exception 'A published update cannot return to draft' using errcode = '23514';
    end if;
  else
    raise exception 'A withdrawn update is final' using errcode = '23514';
  end if;

  new.updated_at := greatest(pg_catalog.clock_timestamp(), old.updated_at + interval '1 microsecond');
  return new;
end;
$$;
revoke all on function public.issuer_updates_guard() from public, anon, authenticated, service_role;
drop trigger if exists issuer_updates_guard on public.issuer_updates;
create trigger issuer_updates_guard before insert or update or delete on public.issuer_updates
  for each row execute function public.issuer_updates_guard();

create table if not exists public.issuer_update_documents (
  network text not null default public.deployment_network()
    check (network in ('mainnet', 'devnet', 'testnet', 'localnet')),
  id uuid primary key default gen_random_uuid(),
  update_id uuid not null references public.issuer_updates(id) on delete cascade,
  version_id uuid not null references public.document_versions(id),
  file_name text not null check (char_length(file_name) between 1 and 200 and file_name !~ '[[:cntrl:]/\\]'),
  storage_path text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer not null check (size_bytes between 1 and 26214400),
  content_type text not null,
  created_by text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (update_id, version_id)
);
create index if not exists issuer_update_documents_update_idx on public.issuer_update_documents (update_id);
alter table public.issuer_update_documents enable row level security;
revoke all on public.issuer_update_documents from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.issuer_update_documents to service_role;

-- ---------------------------------------------------------------------------
-- Document guard. An attachment is the verified version itself: the row must
-- repeat exactly what document_versions recorded for the stored bytes (path,
-- SHA-256, size, type), in the private bucket and under this issuer's prefix
-- on this network. Insert and delete take the parent row's lock, so an
-- attachment cannot slip in while the draft is being published (or deleted),
-- and the 10-document cap holds under concurrency. Both also move the
-- draft's updated_at: the publish route's compare-and-swap then covers the
-- documents too (a document added in another tab is never published unseen).
-- Rows are immutable.
-- ---------------------------------------------------------------------------
create or replace function public.issuer_update_documents_guard()
returns trigger language plpgsql set search_path = '' as $$
declare
  parent public.issuer_updates%rowtype;
  version public.document_versions%rowtype;
begin
  if tg_op = 'UPDATE' then
    raise exception 'An attached document is immutable; remove it and attach the new version' using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then
    select * into parent from public.issuer_updates where id = old.update_id for update;
    -- Deleting the draft itself cascades here after its row is gone (only a
    -- draft can be deleted): no parent row means that cascade.
    if found and parent.status <> 'draft' then
      raise exception 'The documents of a published update cannot be removed' using errcode = '23514';
    end if;
    if found then
      update public.issuer_updates set updated_at = pg_catalog.clock_timestamp() where id = old.update_id;
    end if;
    return old;
  end if;

  select * into parent from public.issuer_updates where id = new.update_id for update;
  if not found or parent.network is distinct from new.network then
    raise exception 'Update not found on this network' using errcode = '23503';
  end if;
  if parent.status <> 'draft' then
    raise exception 'Documents are attached to drafts only' using errcode = '23514';
  end if;
  if (select count(*) from public.issuer_update_documents d where d.update_id = new.update_id) >= 10 then
    raise exception 'An update carries at most 10 documents' using errcode = '23514';
  end if;
  select * into version from public.document_versions where id = new.version_id;
  if not found or version.network is distinct from new.network
     or version.bucket <> 'documents-confidential'
     or version.path not like ('issuer-updates/' || parent.issuer_pda || '/' || new.network || '/%')
     or version.path is distinct from new.storage_path or version.sha256 is distinct from new.sha256
     or version.size_bytes is distinct from new.size_bytes or version.mime_type is distinct from new.content_type then
    raise exception 'The document must match a verified immutable version of this issuer' using errcode = '23514';
  end if;
  update public.issuer_updates set updated_at = pg_catalog.clock_timestamp() where id = new.update_id;
  new.created_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;
revoke all on function public.issuer_update_documents_guard() from public, anon, authenticated, service_role;
drop trigger if exists issuer_update_documents_guard on public.issuer_update_documents;
create trigger issuer_update_documents_guard before insert or update or delete on public.issuer_update_documents
  for each row execute function public.issuer_update_documents_guard();

select mancipatio_ops.install_network_guards();

commit;
