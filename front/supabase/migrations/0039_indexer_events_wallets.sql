-- 0039_indexer_events_wallets.sql — wallet-indexed event history.
--
-- The portfolio "Transaction history" page used to pull the latest N global
-- indexer_events and substring-match the JSON payload client-side, so a wallet
-- whose activity fell outside that window saw "no activity", and every load
-- shipped full JSONB payloads to the browser. Add a `wallets text[]` column the
-- webhook populates from the accounts each event touched, plus a GIN index, so
-- the page can query `wallets @> {wallet}` server-side with pagination and
-- without downloading payloads.
--
-- Backfill note: only events written AFTER this migration + the webhook change
-- carry `wallets`; historical rows stay unindexed (the page still works, it
-- just won't surface pre-migration events by wallet). A one-off backfill from
-- `payload` can be run later if needed.

alter table public.indexer_events
  add column if not exists wallets text[];

create index if not exists indexer_events_wallets_gin
  on public.indexer_events using gin (wallets);
