-- 0033: Recurring payout schedules (off-chain planning registry).
--
-- Admins register a per-share-class payout cadence (monthly / quarterly /
-- annual) with a next-due date and an optional amount hint. /admin/payouts
-- surfaces overdue and soon-due schedules and lets an admin either prefill a
-- push-distribution from the row or "mark done" (advance next_due by one
-- cadence period). /issuer/payouts shows a read-only "Upcoming payouts" card
-- for the issuer's own share classes.
--
-- These rows are PLANNING metadata only — nothing here moves funds. The
-- actual money movement stays in the on-chain push-distribution flow
-- (create_distribution / distribute_batch).
--
-- RLS (0031 style — locked from day one):
--   - anon SELECT: YES — and that makes EVERY column world-readable,
--     including `notes` and `amount_hint`, on active AND inactive rows. The
--     issuer "Upcoming payouts" card and the admin panel both read
--     client-side with the anon key. Rows contain no PII, but treat all
--     content as PUBLIC: the admin UI labels `notes` as public and per-client
--     commercial terms must live in the fee register (signed reads), never
--     here. If notes ever need to be confidential, move reads behind a
--     signed route and drop this policy.
--   - anon writes: NONE, ever. All writes go through the signed service-role
--     routes /api/payout-schedules/upsert and /api/payout-schedules/delete
--     (SIWS + on-chain admin gate; created_by is stamped with the verified
--     signer). The service role bypasses RLS, so no write policy is needed.
--
-- FOLLOW-UP (deliberately NOT built here): there is no keeper/cron that
-- notifies anyone or auto-advances next_due when a date passes — "due" is
-- computed at read time in the UI. If automated reminders are ever wanted,
-- add a scheduled job (Supabase cron / external keeper) that reads
-- (active, next_due) and emits notifications; the (active, next_due) index
-- below is already shaped for that query.

create table if not exists public.payout_schedules (
  id              uuid primary key default gen_random_uuid(),
  share_class_pda text not null,
  mint            text,
  label           text,
  cadence         text not null check (cadence in ('monthly', 'quarterly', 'annual')),
  next_due        date not null,
  amount_hint     numeric,
  payment_mint    text,
  active          boolean not null default true,
  notes           text,
  created_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Due-scan shape: "active schedules ordered by / filtered on next_due".
create index if not exists payout_schedules_active_next_due_idx
  on public.payout_schedules (active, next_due);

create trigger payout_schedules_touch before update on public.payout_schedules
  for each row execute function public.touch_updated_at();

alter table public.payout_schedules enable row level security;

-- anon matrix: SELECT only (issuer page reads client-side). No INSERT /
-- UPDATE / DELETE policies — writes are signed-route + service-role only.
drop policy if exists "payout_schedules anon read" on public.payout_schedules;
create policy "payout_schedules anon read"
  on public.payout_schedules for select using (true);
