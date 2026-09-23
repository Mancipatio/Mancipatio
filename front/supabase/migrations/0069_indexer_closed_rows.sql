-- 0069 (program 2D): keep the history of accounts whose rent was reclaimed.
--
-- `reclaim_rent` tombstones a terminal Offer / OtcDeal / CustodyVault: the
-- account shrinks to the 8-byte CLOSED_ACCOUNT_TAG and no longer decodes. The
-- indexer then treats it as closed and deletes its mirror row (both
-- apply_indexer_snapshot delete paths in 0047 and the TypeScript full
-- reconcile). The BEFORE DELETE triggers below copy that last mirrored row
-- here first, so history pages can still show it (decoded from raw.base64).
--
-- * offers, custody_vaults: archived by trigger (no function redefinition).
-- * otc_deals: not mirrored (lib/otc.ts scans live); the admin archive route
--   writes their rows before the reclaim, with table_name = 'otc_deals'.
-- * kyc_entries: deliberately NOT archived (data minimisation; the dossier
--   lives in `clients`).
--
-- Apply BEFORE the front that ships the reclaim buttons. Backward compatible
-- in both directions: nothing reads this table until that front is deployed,
-- and before 2D no offer or custody vault was ever closed.
begin;
set local lock_timeout = '15s';

create table if not exists public.indexer_closed_rows (
  network     text not null,
  table_name  text not null
    check (table_name in ('offers', 'custody_vaults', 'otc_deals')),
  pda         text not null,
  closed_slot bigint,
  row         jsonb not null,
  closed_at   timestamptz not null default now(),
  primary key (network, table_name, pda)
);

comment on table public.indexer_closed_rows is
  'Last mirrored row of an Offer / CustodyVault (trigger) or OtcDeal (admin archive route) whose rent was reclaimed (2D tombstone). History only, never live state.';

-- Readable like the mirrors (0002); no write policy, so only service_role
-- (and the trigger below) can write.
alter table public.indexer_closed_rows enable row level security;
drop policy if exists "indexer_closed_rows anon read" on public.indexer_closed_rows;
create policy "indexer_closed_rows anon read"
  on public.indexer_closed_rows for select using (true);

create or replace function public.archive_indexer_closed_row()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.indexer_closed_rows (network, table_name, pda, closed_slot, row)
  values (OLD.network, TG_TABLE_NAME, OLD.pda, OLD.last_slot, to_jsonb(OLD))
  on conflict (network, table_name, pda) do update
    set closed_slot = excluded.closed_slot,
        row = excluded.row,
        closed_at = now();
  return OLD;
end $$;

revoke all on function public.archive_indexer_closed_row() from public, anon, authenticated;

drop trigger if exists archive_closed_row on public.offers;
create trigger archive_closed_row
  before delete on public.offers
  for each row execute function public.archive_indexer_closed_row();

drop trigger if exists archive_closed_row on public.custody_vaults;
create trigger archive_closed_row
  before delete on public.custody_vaults
  for each row execute function public.archive_indexer_closed_row();

commit;
