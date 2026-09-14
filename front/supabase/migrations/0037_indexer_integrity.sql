-- 0037_indexer_integrity.sql — webhook idempotency + stale-write protection.
--
-- Pairs with the helius-webhook changes:
--   1. indexer_events is now UPSERTed on (network, signature) instead of blind
--      INSERT, so a Helius retry/redelivery (the webhook now returns non-2xx on
--      failure to trigger retries) no longer duplicates ledger rows. This adds
--      the unique index the upsert's onConflict needs (after de-duping any
--      rows a prior blind-insert build already created).
--   2. A BEFORE UPDATE guard on every indexer entity table rejects an OLDER
--      snapshot landing over a newer one: two concurrent webhook deliveries
--      for the same PDA could otherwise write the stale one last. If the
--      incoming last_slot is behind the stored one, the update is skipped.
--
-- Idempotent.

-- ---------------------------------------------------------------------------
-- 1. indexer_events: de-dup existing (network, signature) collisions, then add
--    the unique index the webhook upsert relies on.
-- ---------------------------------------------------------------------------
delete from public.indexer_events a
using public.indexer_events b
where a.ctid < b.ctid
  and a.network = b.network
  and a.signature = b.signature;

create unique index if not exists indexer_events_network_signature_uidx
  on public.indexer_events (network, signature);

-- ---------------------------------------------------------------------------
-- 2. last_slot stale-write guard (BEFORE UPDATE) on every indexer entity table.
--    Returning NULL from a BEFORE UPDATE trigger skips the row write, so an
--    out-of-order (older-slot) upsert becomes a no-op instead of clobbering a
--    newer snapshot. Equal slots are allowed (idempotent re-process).
-- ---------------------------------------------------------------------------
create or replace function public.indexer_reject_stale_slot()
returns trigger
language plpgsql
as $$
begin
  if new.last_slot is not null
     and old.last_slot is not null
     and new.last_slot < old.last_slot then
    return null; -- skip: incoming snapshot is older than the stored one
  end if;
  return new;
end;
$$;

do $$
declare
  t text;
  tables text[] := array[
    'platforms', 'issuers', 'assets', 'share_classes', 'sales',
    'custody_vaults', 'offers', 'proposals', 'vote_records',
    'rights_issuances', 'milestones', 'milestone_claims'
  ];
begin
  foreach t in array tables loop
    -- Only attach where the table (and its last_slot column) actually exists.
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'last_slot'
    ) then
      execute format(
        'drop trigger if exists %I on public.%I',
        t || '_reject_stale_slot', t
      );
      execute format(
        'create trigger %I before update on public.%I
           for each row execute function public.indexer_reject_stale_slot()',
        t || '_reject_stale_slot', t
      );
    end if;
  end loop;
end $$;
