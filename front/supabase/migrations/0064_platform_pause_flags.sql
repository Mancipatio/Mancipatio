-- 0064: Platform.paused (bool) -> Platform.pause_flags (u8), same byte 74 of
-- the on-chain account (program package 2A). EXPAND step: add pause_flags and
-- keep `paused` (the indexer now writes it as pause_flags <> 0).
--
-- Numbered 0064, AFTER 0063_operational_retention.sql: the two are independent,
-- and "0063 applied" must never be read as "pause_flags present".
--
-- Apply BEFORE the front that decodes pause_flags is merged:
-- apply_indexer_snapshot (0047) raises on any decoded column the table lacks.
-- CONTRACT (drop `paused`) comes in a later migration, once nothing reads it.
--
-- The check allows every u8 value, not only today's 0x3F: a future pause bit
-- must never make the indexer reject the Platform account.
-- Run with --single-transaction; the lock timeout keeps a busy table from
-- holding the migration.
begin;
set local lock_timeout = '15s';

alter table public.platforms
  add column if not exists pause_flags smallint not null default 0
  check (pause_flags between 0 and 255);

-- Rows indexed before this migration: the old `paused = true` is bit0.
-- Only v2 snapshot rows: the 0047 trigger (indexer_reject_stale_slot) raises on
-- an UPDATE of a row without layout_version 2 / last_slot, which would abort
-- this migration, and silently skips a row an in-flight newer snapshot already
-- superseded. Every row left out here is rewritten, pause_flags included, by
-- the next snapshot of the Platform account (every gated transaction touches
-- it); until then its pause_flags reads 0 while `paused` keeps the old value.
update public.platforms set pause_flags = 1
 where paused and pause_flags = 0 and layout_version = 2 and last_slot is not null;

comment on column public.platforms.pause_flags is
  'Emergency-pause bitmask (Platform byte 74): 0x01 onboarding, 0x02 primary, 0x04 secondary, 0x08 custody entry, 0x10 distributions, 0x20 issuer proceeds.';
comment on column public.platforms.paused is
  'Deprecated: pause_flags <> 0. Dropped by a later contract migration.';

commit;
