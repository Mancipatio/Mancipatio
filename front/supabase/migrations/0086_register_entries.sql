-- 0086: register entries — the company-register side of the cap table.
--
-- A conversion ends on chain with the realize burn (0034,
-- realize_custody_vault) and off chain with the registry decision (APR in
-- Serbia) that records the holder's stake in the company. This table is the
-- platform's record of those decisions, so the chain and the register can be
-- reconciled (/admin/cap-table, /issuer/cap-table) and the public asset page
-- can show what was converted into registered ownership
-- (/api/cap-table/public, without any personal data or case number).
--
--   units                  share-class units (mint decimals are 0), > 0
--   percent_bps            the stake as written in the decision, in basis
--                          points with up to four decimals (250 = 2.5 %; a
--                          class of 1,000,000 units has 0.01 bps per unit)
--   registry               the register that decided ('APR' by default)
--   decision_ref           the case number: admin and issuer views only,
--                          never public
--   decision_date          the date of the decision
--   decision_doc_sha256    SHA-256 (lower-case hex) of the decision document
--   conversion_request_id  the converted request this entry registers
--   realize_tx             the realize signature this entry registers
--   holder_client_id       the holder's dossier: a personal-data link that
--                          only the admin routes read
--   status                 'recorded', or 'voided' with a reason (terminal)
--
-- Lifecycle (guard trigger, defense in depth under the admin routes):
--   insert  status 'recorded' with no void fields; a decision date not in the
--           future; a linked conversion request on the same network and share
--           class, 'converted', whose outcome_tx equals realize_tx when both
--           are set
--   update  only recorded -> voided (reason and actor required, the time is
--           the database's); every other column is immutable, so a correction
--           is a void plus a new entry. The one exception is the foreign key's
--           ON DELETE SET NULL on holder_client_id (detaching a dossier),
--           which is allowed on any row and changes nothing else
--   delete  refused: a register record is voided, never deleted
-- One recorded entry per conversion request (partial unique index): voiding
-- an entry frees its request for a corrected one.
--
-- RLS: enabled with NO policies (default-deny, same stance as
-- conversion_requests in 0034). Service role only: the signed admin routes
-- (/api/cap-table/*), the issuer read (wallets, units and decision references
-- only) and the public read, which selects only non-personal columns of
-- recorded rows. No role is granted DELETE.
begin;
set local lock_timeout = '15s';

create table if not exists public.register_entries (
  id uuid primary key default gen_random_uuid(),
  network text not null default public.deployment_network()
    check (network in ('mainnet', 'devnet', 'testnet', 'localnet')),
  share_class_pda text not null check (share_class_pda ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  asset_pda text not null check (asset_pda ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  units numeric(39, 0) not null check (units > 0 and units <= 18446744073709551615),
  percent_bps numeric(10, 4) not null check (percent_bps > 0 and percent_bps <= 10000),
  registry text not null default 'APR' check (length(btrim(registry)) between 1 and 80),
  decision_ref text not null check (length(btrim(decision_ref)) between 1 and 120),
  decision_date date not null check (decision_date >= date '2000-01-01'),
  decision_doc_sha256 text not null
    check (decision_doc_sha256 ~ '^[0-9a-f]{64}$' and decision_doc_sha256 !~ '^0+$'),
  conversion_request_id uuid references public.conversion_requests(id) on delete restrict,
  realize_tx text check (realize_tx is null or realize_tx ~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$'),
  holder_client_id uuid references public.clients(id) on delete set null,
  note text not null default '' check (length(note) <= 2000),
  status text not null default 'recorded' check (status in ('recorded', 'voided')),
  void_reason text check (void_reason is null or length(btrim(void_reason)) between 1 and 500),
  voided_by text check (voided_by is null or length(voided_by) between 1 and 64),
  voided_at timestamptz,
  created_by text not null check (length(created_by) between 1 and 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'recorded' and void_reason is null and voided_by is null and voided_at is null) or
    (status = 'voided' and void_reason is not null and voided_by is not null and voided_at is not null)
  )
);

create index if not exists register_entries_class_idx
  on public.register_entries (network, share_class_pda);
create index if not exists register_entries_asset_idx
  on public.register_entries (network, asset_pda);
create unique index if not exists register_entries_conversion_once
  on public.register_entries (conversion_request_id)
  where status = 'recorded' and conversion_request_id is not null;

alter table public.register_entries enable row level security;
revoke all on public.register_entries from public, anon, authenticated, service_role;
grant select, insert, update on public.register_entries to service_role;

-- SECURITY DEFINER: the insert check reads conversion_requests whatever the
-- caller's grants on it; the search path is empty, so every name is
-- schema-qualified.
create or replace function public.register_entries_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  linked record;
begin
  if tg_op = 'DELETE' then
    raise exception 'Register entries are never deleted; void the entry instead'
      using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'recorded' or new.void_reason is not null
       or new.voided_by is not null or new.voided_at is not null then
      raise exception 'A register entry is recorded first and can only be voided later'
        using errcode = '23514';
    end if;
    -- One day of slack for time zones: the registry's date is local.
    if new.decision_date > (pg_catalog.now() at time zone 'UTC')::date + 1 then
      raise exception 'The decision date is in the future' using errcode = '23514';
    end if;
    if new.conversion_request_id is not null then
      select c.network, c.share_class_pda, c.status, c.outcome_tx
        into linked
        from public.conversion_requests c
       where c.id = new.conversion_request_id;
      if not found or linked.network <> new.network
         or linked.share_class_pda <> new.share_class_pda
         or linked.status <> 'converted' then
        raise exception 'The linked conversion request must be converted, on this network and share class'
          using errcode = '23514';
      end if;
      if new.realize_tx is not null and linked.outcome_tx is distinct from new.realize_tx then
        raise exception 'realize_tx must equal the linked conversion''s outcome_tx'
          using errcode = '23514';
      end if;
    end if;
    new.created_at := pg_catalog.now();
    new.updated_at := new.created_at;
    return new;
  end if;

  -- UPDATE. The register content never changes.
  if (new.id, new.network, new.share_class_pda, new.asset_pda, new.units, new.percent_bps,
      new.registry, new.decision_ref, new.decision_date, new.decision_doc_sha256,
      new.conversion_request_id, new.realize_tx, new.note, new.created_by, new.created_at)
     is distinct from
     (old.id, old.network, old.share_class_pda, old.asset_pda, old.units, old.percent_bps,
      old.registry, old.decision_ref, old.decision_date, old.decision_doc_sha256,
      old.conversion_request_id, old.realize_tx, old.note, old.created_by, old.created_at) then
    raise exception 'A register entry is immutable; void it and record a corrected one'
      using errcode = '23514';
  end if;
  -- The dossier link may only be detached (ON DELETE SET NULL), never moved.
  if new.holder_client_id is distinct from old.holder_client_id and new.holder_client_id is not null then
    raise exception 'The holder link of a register entry cannot be changed' using errcode = '23514';
  end if;
  if old.status = 'voided' then
    if (new.status, new.void_reason, new.voided_by, new.voided_at)
       is distinct from (old.status, old.void_reason, old.voided_by, old.voided_at) then
      raise exception 'A voided register entry is final' using errcode = '23514';
    end if;
  elsif new.status = 'voided' then
    if coalesce(pg_catalog.btrim(new.void_reason), '') = '' or new.voided_by is null then
      raise exception 'Voiding a register entry needs a reason and the acting wallet'
        using errcode = '23514';
    end if;
    new.voided_at := pg_catalog.now();
  elsif new.void_reason is not null or new.voided_by is not null or new.voided_at is not null then
    raise exception 'Void fields belong to a voided entry' using errcode = '23514';
  end if;
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;
revoke all on function public.register_entries_guard() from public, anon, authenticated, service_role;

drop trigger if exists register_entries_guard on public.register_entries;
create trigger register_entries_guard
  before insert or update or delete on public.register_entries
  for each row execute function public.register_entries_guard();

select mancipatio_ops.install_network_guards();

commit;
