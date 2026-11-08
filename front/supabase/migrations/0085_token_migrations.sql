-- 0085: token migrations (V1, operator-delivered).
--
-- A company that already issued a token on Solana (an SPL Token or
-- Token-2022 mint on another platform) moves its community onto Manci:
-- during an opt-in window of 60–90 days its holders deposit exact multiples
-- of a published lot of the old token into a deposit token account a
-- Manci-controlled owner holds (a Squads vault recommended), and the
-- operator sends each of them units of the company's Manci share class from
-- the treasury wallet (the existing hook-aware "Send to holder" tooling).
-- No program change: deposits, refunds and the burn of the collected tokens
-- are plain SPL transfers, so no pause bit of asset_registry covers them; the
-- platform's switches are the routes and the status below
-- (lib/token-migration/model.ts, ops/runbook-mainnet.md §22).
--
--   token_migrations          one campaign: the old mint and its supply
--                             snapshot, the ratio (E, G, lot, units cap,
--                             lib/token-migration/ratio.ts), the deposit
--                             account, the window, the Swap Terms hash, the
--                             treasury, and after completion the final report
--                             (text and SHA-256, immutable) and the burn
--   token_migration_deposits  one row per deposit transaction (unique per
--                             network): accepted (units due), irregular
--                             (refund due, with a reason code), delivered,
--                             refunded
--   record_token_migration_deposit   the one insert path: serialized per
--                             campaign, so the units cap can never be passed
--                             (a deposit over it is recorded irregular)
--   record_token_migration_delivery  marks accepted deposits delivered by one
--                             transaction, atomically; a delivery signature is
--                             never reused for other deposits
--   record_token_migration_refund    the same for refunds: one transaction may
--                             return several deposits of ONE holder (dust
--                             spread over many transfers costs one refund),
--                             never deposits of another holder or campaign
--
-- A deposit account belongs to one campaign for good (a unique index over
-- every campaign that ever opened: a re-run needs a fresh deposit owner), and
-- nothing that reached it before the campaign opened counts (opened_slot:
-- the finalized slot read when it opened; earlier transfers are refused).
-- Both tables are service-role only (RLS on, no policy): every write goes
-- through the signed routes under app/api/token-migrations, and the public
-- pages read an aggregate through the server (wallets, amounts and
-- signatures are public on chain anyway; no personal data is stored). The
-- guard triggers repeat the lifecycle the routes enforce.
--
-- Base-unit amounts are numeric(39,0): an old token's supply can reach
-- u64::MAX base units. The routes read them as text (lib/token-migration/
-- rows.ts) and never through a JavaScript number.
--
-- New network columns default to public.deployment_network() and get the
-- 0071 guard (the last statement). Re-runnable: create … if not exists and
-- create or replace throughout.
--
-- Rollback (not a migration; only while no campaign has opened):
--   drop function public.record_token_migration_refund(uuid, text, uuid[]);
--   drop function public.record_token_migration_delivery(uuid, text, uuid[]);
--   drop function public.record_token_migration_deposit(uuid, text, text, bigint, timestamptz, numeric, numeric, text, text, text);
--   drop table public.token_migration_deposits; drop table public.token_migrations;
--   drop function public.token_migration_deposits_guard(); drop function public.token_migrations_guard();
begin;
set local lock_timeout = '15s';

-- ── 1. Campaigns ──────────────────────────────────────────────────────────
create table if not exists public.token_migrations (
  id uuid primary key default gen_random_uuid(),
  network text not null default public.deployment_network()
    check (network in ('mainnet', 'devnet', 'testnet', 'localnet')),
  -- /migrations/<slug>, unique per network.
  slug text not null check (length(slug) between 3 and 64 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  status text not null default 'draft'
    check (status in ('draft', 'open', 'closed', 'completed', 'cancelled')),
  -- The company the units are a share of, as the public pages name it.
  company_name text not null check (length(btrim(company_name)) between 1 and 120),
  -- The Manci side, verified on chain by the save route.
  issuer_pda text not null check (issuer_pda ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  asset_pda text not null check (asset_pda ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  share_class_pda text not null check (share_class_pda ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  new_mint text not null check (new_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  -- The old token (V1: Solana only), read from chain when the draft is saved.
  old_chain text not null default 'solana' check (old_chain in ('solana')),
  old_mint text not null check (old_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  old_token_program text not null check (old_token_program in (
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')),
  old_decimals smallint not null check (old_decimals between 0 and 18),
  old_symbol text not null check (length(btrim(old_symbol)) between 1 and 16),
  old_name text not null check (length(btrim(old_name)) between 1 and 80),
  old_total_supply numeric(39, 0) not null check (old_total_supply between 1 and 18446744073709551615),
  -- Excluded wallets (team, treasury, liquidity pools…) and their balances
  -- read on chain, plus a manual extra the note explains (locked, burned).
  excluded_wallets text[] not null default '{}' check (cardinality(excluded_wallets) <= 100),
  excluded_wallet_amount numeric(39, 0) not null default 0 check (excluded_wallet_amount >= 0),
  excluded_manual_amount numeric(39, 0) not null default 0 check (excluded_manual_amount >= 0),
  excluded_amount numeric(39, 0) not null default 0,
  excluded_note text not null default '' check (length(excluded_note) <= 2000),
  supply_read_at timestamptz not null,
  -- The ratio (lib/token-migration/ratio.ts is the authority; the CHECKs
  -- below keep a hand-edited row consistent with its invariants).
  equity_bps integer not null check (equity_bps between 1 and 10000),
  granularity bigint not null default 1000000 check (granularity in (10000, 100000, 1000000, 10000000)),
  lot_base_units numeric(39, 0) not null check (lot_base_units >= 1),
  units_cap numeric(39, 0) not null check (units_cap >= 1),
  source text not null check (source in ('founder_transfer', 'capital_increase')),
  unclaimed_policy text not null check (unclaimed_policy in ('return_to_source', 'not_issued')),
  -- The deposit token account: the deposit owner's ATA of the old mint.
  deposit_owner text not null check (deposit_owner ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  deposit_ata text not null check (deposit_ata ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  window_opens_at timestamptz not null,
  window_closes_at timestamptz not null,
  -- The Swap Terms document (required before the campaign opens).
  terms_doc_sha256 text check (terms_doc_sha256 is null or terms_doc_sha256 ~ '^[0-9a-f]{64}$'),
  terms_doc_url text check (terms_doc_url is null or (length(terms_doc_url) <= 500 and terms_doc_url ~ '^https://[^[:space:]]+$')),
  -- The wallet holding the minted units the operator delivers.
  treasury_wallet text not null check (treasury_wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  -- After completion: the report exactly as served, and its SHA-256.
  final_report text check (final_report is null or length(final_report) <= 5000000),
  final_report_sha256 text check (final_report_sha256 is null or final_report_sha256 ~ '^[0-9a-f]{64}$'),
  -- The deposit owner's burn of the collected old tokens.
  old_tokens_burn_tx text check (old_tokens_burn_tx is null or old_tokens_burn_tx ~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$'),
  old_tokens_burned numeric(39, 0) check (old_tokens_burned is null or old_tokens_burned >= 1),
  created_by text not null check (created_by ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  updated_by text check (updated_by is null or updated_by ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  -- The finalized slot read when the campaign opened: no transfer before it is a deposit.
  opened_slot bigint check (opened_slot is null or opened_slot >= 0),
  -- The operator's reconcile sweeps the deposit account's history backwards,
  -- a bounded amount per run: reconcile_cursor is the newest signature of the
  -- last completed sweep (it and everything older down to the opening slot
  -- was examined); a sweep in progress covers reconcile_sweep_top (the newest
  -- signature when it started) down to reconcile_sweep_before (the oldest
  -- examined so far), and the next run continues below it.
  reconcile_cursor text check (reconcile_cursor is null or reconcile_cursor ~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$'),
  reconcile_sweep_top text check (reconcile_sweep_top is null or reconcile_sweep_top ~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$'),
  reconcile_sweep_before text check (reconcile_sweep_before is null or reconcile_sweep_before ~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$'),
  opened_at timestamptz,
  closed_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (network, slug),
  check (excluded_amount = excluded_wallet_amount + excluded_manual_amount),
  check (excluded_amount < old_total_supply),
  check (window_closes_at - window_opens_at between interval '60 days' and interval '90 days'),
  check (units_cap = floor((old_total_supply - excluded_amount) / lot_base_units)),
  check (units_cap <= floor(equity_bps::numeric * granularity / 10000)),
  check (lot_base_units * floor(equity_bps::numeric * granularity / 10000) >= old_total_supply - excluded_amount),
  check (status = 'draft' or status = 'cancelled' or (terms_doc_sha256 is not null and terms_doc_url is not null)),
  check ((status = 'completed') = (final_report is not null and final_report_sha256 is not null)),
  check ((old_tokens_burn_tx is null) = (old_tokens_burned is null)),
  check ((opened_at is null) = (opened_slot is null)),
  check ((reconcile_sweep_top is null) = (reconcile_sweep_before is null))
);
-- One campaign per deposit account, for good: deposits are told apart by the
-- account they land in, so an account a campaign ever opened on (it has an
-- opening slot, whatever its status now) is never another campaign's.
create unique index if not exists token_migrations_deposit_ata_once
  on public.token_migrations (network, deposit_ata) where opened_slot is not null;
-- A burn proves one campaign's burn.
create unique index if not exists token_migrations_burn_once
  on public.token_migrations (network, old_tokens_burn_tx) where old_tokens_burn_tx is not null;
create index if not exists token_migrations_status_idx on public.token_migrations (network, status);
alter table public.token_migrations enable row level security;
revoke all on public.token_migrations from public, anon, authenticated, service_role;
grant select, insert, update on public.token_migrations to service_role;

-- ── 2. Deposits ───────────────────────────────────────────────────────────
create table if not exists public.token_migration_deposits (
  id uuid primary key default gen_random_uuid(),
  migration_id uuid not null references public.token_migrations (id) on delete restrict,
  network text not null default public.deployment_network()
    check (network in ('mainnet', 'devnet', 'testnet', 'localnet')),
  holder_wallet text not null check (holder_wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  deposit_tx text not null check (deposit_tx ~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$'),
  deposit_slot bigint not null check (deposit_slot >= 0),
  block_time timestamptz not null,
  amount_base numeric(39, 0) not null check (amount_base between 1 and 18446744073709551615),
  units_due numeric(39, 0) not null check (units_due >= 0),
  status text not null check (status in ('accepted', 'irregular', 'delivered', 'refunded')),
  reason_code text check (reason_code is null or reason_code in (
    'not_lot_multiple', 'outside_window', 'excluded_wallet', 'over_cap', 'memo_mismatch',
    'not_signed_by_holder', 'not_open', 'compliance_hold')),
  reason text check (reason is null or length(reason) <= 500),
  delivery_tx text check (delivery_tx is null or delivery_tx ~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$'),
  refund_tx text check (refund_tx is null or refund_tx ~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$'),
  recorded_via text not null check (recorded_via in ('holder', 'reconcile')),
  delivered_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (network, deposit_tx),
  check (status <> 'irregular' or (reason_code is not null and units_due = 0)),
  check (status not in ('accepted', 'delivered') or (reason_code is null and units_due >= 1)),
  check ((status = 'delivered') = (delivery_tx is not null)),
  check ((status = 'refunded') = (refund_tx is not null))
);
create index if not exists token_migration_deposits_migration_idx
  on public.token_migration_deposits (migration_id, status);
create index if not exists token_migration_deposits_holder_idx
  on public.token_migration_deposits (network, holder_wallet);
-- A refund transaction returns deposits of one holder of one campaign
-- (record_token_migration_refund; the guard below refuses anything wider).
create index if not exists token_migration_deposits_refund_idx
  on public.token_migration_deposits (network, refund_tx) where refund_tx is not null;
create index if not exists token_migration_deposits_delivery_idx
  on public.token_migration_deposits (network, delivery_tx) where delivery_tx is not null;
alter table public.token_migration_deposits enable row level security;
revoke all on public.token_migration_deposits from public, anon, authenticated, service_role;
grant select, insert, update on public.token_migration_deposits to service_role;

-- ── 3. Campaign lifecycle guard ───────────────────────────────────────────
--   draft  -> open | cancelled
--   open   -> closed | cancelled
--   closed -> completed | cancelled
--   completed / cancelled: terminal.
-- Once a campaign leaves draft, what it published is frozen (the old token,
-- the ratio, the deposit account, the window, the Terms, the treasury), and
-- so is its opening slot. Cancelling is refused once a deposit was delivered
-- (units left the treasury: complete instead) or the collected tokens were
-- burned (refunds would then be owed from an empty account); completing is
-- refused while a deposit is still accepted or irregular. The final report
-- is written once, on the closed -> completed step, and never changes; its
-- completion time is the route's (kept when within five minutes of the
-- database clock) so the report can be rebuilt from the row. The burn is
-- recorded once, on a closed or completed campaign whose every deposit is
-- settled (delivered or refunded). Deleting is refused except for a draft
-- (which can hold no deposit).
create or replace function public.token_migrations_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Only a draft token migration can be deleted' using errcode = '23514';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.final_report is not null or new.old_tokens_burn_tx is not null
       or new.opened_slot is not null or new.reconcile_cursor is not null or new.reconcile_sweep_top is not null
       or new.opened_at is not null or new.closed_at is not null or new.completed_at is not null or new.cancelled_at is not null then
      raise exception 'A token migration starts as a bare draft' using errcode = '23514';
    end if;
    new.created_at := pg_catalog.clock_timestamp();
    new.updated_at := new.created_at;
    return new;
  end if;

  if new.id <> old.id or new.network <> old.network or new.created_by <> old.created_by or new.created_at <> old.created_at then
    raise exception 'Token migration identity is immutable' using errcode = '23514';
  end if;
  if new.status is distinct from old.status then
    if not (
      (old.status = 'draft' and new.status in ('open', 'cancelled')) or
      (old.status = 'open' and new.status in ('closed', 'cancelled')) or
      (old.status = 'closed' and new.status in ('completed', 'cancelled'))
    ) then
      raise exception 'illegal token migration status transition: % -> %', old.status, new.status using errcode = '23514';
    end if;
    if new.status = 'cancelled' and exists (
      select 1 from public.token_migration_deposits d where d.migration_id = old.id and d.status = 'delivered'
    ) then
      raise exception 'A token migration with delivered deposits cannot be cancelled' using errcode = '23514';
    end if;
    if new.status = 'cancelled' and old.old_tokens_burn_tx is not null then
      raise exception 'A token migration whose collected tokens were burned cannot be cancelled' using errcode = '23514';
    end if;
    if new.status = 'completed' and exists (
      select 1 from public.token_migration_deposits d where d.migration_id = old.id and d.status in ('accepted', 'irregular')
    ) then
      raise exception 'Every deposit must be delivered or refunded before the token migration completes' using errcode = '23514';
    end if;
    case new.status
      when 'open' then new.opened_at := pg_catalog.clock_timestamp();
      when 'closed' then new.closed_at := pg_catalog.clock_timestamp();
      when 'completed' then
        -- The route's completion time, which the final report states, when it is plausible.
        if new.completed_at is null
           or new.completed_at not between pg_catalog.clock_timestamp() - interval '5 minutes'
                                   and pg_catalog.clock_timestamp() + interval '5 minutes' then
          new.completed_at := pg_catalog.clock_timestamp();
        end if;
      when 'cancelled' then new.cancelled_at := pg_catalog.clock_timestamp();
      else null;
    end case;
  else
    new.opened_at := old.opened_at;
    new.closed_at := old.closed_at;
    new.completed_at := old.completed_at;
    new.cancelled_at := old.cancelled_at;
  end if;
  if old.opened_slot is not null and new.opened_slot is distinct from old.opened_slot then
    raise exception 'The opening slot of a token migration never changes' using errcode = '23514';
  end if;
  if new.opened_slot is distinct from old.opened_slot and not (old.status = 'draft' and new.status = 'open') then
    raise exception 'The opening slot is set when the token migration opens' using errcode = '23514';
  end if;
  if old.status <> 'draft' and (
    new.slug, new.company_name, new.issuer_pda, new.asset_pda, new.share_class_pda, new.new_mint,
    new.old_chain, new.old_mint, new.old_token_program, new.old_decimals, new.old_symbol, new.old_name,
    new.old_total_supply, new.excluded_wallets, new.excluded_wallet_amount, new.excluded_manual_amount,
    new.excluded_amount, new.excluded_note, new.supply_read_at, new.equity_bps, new.granularity,
    new.lot_base_units, new.units_cap, new.source, new.unclaimed_policy, new.deposit_owner, new.deposit_ata,
    new.window_opens_at, new.window_closes_at, new.terms_doc_sha256, new.terms_doc_url, new.treasury_wallet
  ) is distinct from (
    old.slug, old.company_name, old.issuer_pda, old.asset_pda, old.share_class_pda, old.new_mint,
    old.old_chain, old.old_mint, old.old_token_program, old.old_decimals, old.old_symbol, old.old_name,
    old.old_total_supply, old.excluded_wallets, old.excluded_wallet_amount, old.excluded_manual_amount,
    old.excluded_amount, old.excluded_note, old.supply_read_at, old.equity_bps, old.granularity,
    old.lot_base_units, old.units_cap, old.source, old.unclaimed_policy, old.deposit_owner, old.deposit_ata,
    old.window_opens_at, old.window_closes_at, old.terms_doc_sha256, old.terms_doc_url, old.treasury_wallet
  ) then
    raise exception 'The published terms of a token migration are frozen once it opens' using errcode = '23514';
  end if;
  if (new.final_report, new.final_report_sha256) is distinct from (old.final_report, old.final_report_sha256)
     and not (old.status = 'closed' and new.status = 'completed' and old.final_report is null) then
    raise exception 'The final report is written once, when the token migration completes' using errcode = '23514';
  end if;
  if (new.old_tokens_burn_tx, new.old_tokens_burned) is distinct from (old.old_tokens_burn_tx, old.old_tokens_burned) then
    if old.old_tokens_burn_tx is not null then
      raise exception 'The burn of a token migration is recorded once' using errcode = '23514';
    end if;
    if new.status not in ('closed', 'completed') then
      raise exception 'The burn is recorded after the window, on a closed or completed token migration' using errcode = '23514';
    end if;
    if exists (
      select 1 from public.token_migration_deposits d where d.migration_id = old.id and d.status in ('accepted', 'irregular')
    ) then
      raise exception 'The burn is recorded once every deposit is delivered or refunded' using errcode = '23514';
    end if;
  end if;
  if (new.reconcile_cursor, new.reconcile_sweep_top, new.reconcile_sweep_before)
       is distinct from (old.reconcile_cursor, old.reconcile_sweep_top, old.reconcile_sweep_before)
     and new.status not in ('open', 'closed', 'cancelled') then
    raise exception 'The reconcile cursor moves only while deposits are recorded' using errcode = '23514';
  end if;
  new.updated_at := greatest(pg_catalog.clock_timestamp(), old.updated_at + interval '1 microsecond');
  return new;
end;
$$;
revoke all on function public.token_migrations_guard() from public, anon, authenticated, service_role;
drop trigger if exists token_migrations_guard on public.token_migrations;
create trigger token_migrations_guard before insert or update or delete on public.token_migrations
  for each row execute function public.token_migrations_guard();

-- ── 4. Deposit lifecycle guard ────────────────────────────────────────────
--   insert: only into an open, closed or cancelled campaign of the same
--           network, at or after its opening slot, as accepted or irregular
--           (a cancelled campaign takes irregular rows only: they are
--           refunded); the campaign row is locked, so concurrent inserts are
--           serialized and the accepted and delivered units can never pass
--           the units cap
--   accepted  -> delivered | refunded (refunded only in a cancelled campaign)
--   irregular -> refunded
--   delivered / refunded: terminal. What the chain proved (holder, signature,
--   slot, time, amount, units) never changes; rows are never deleted. A
--   refund transaction returns deposits of one holder of one campaign only.
create or replace function public.token_migration_deposits_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  m record;
  taken numeric;
begin
  if tg_op = 'DELETE' then
    raise exception 'Token migration deposits are never deleted' using errcode = '23514';
  end if;
  select t.id, t.network, t.status, t.units_cap, t.lot_base_units, t.opened_slot into m
    from public.token_migrations t where t.id = new.migration_id for update;
  if not found or m.network <> new.network then
    raise exception 'Unknown token migration for this network' using errcode = '23503';
  end if;
  if tg_op = 'INSERT' then
    if m.status not in ('open', 'closed', 'cancelled') then
      raise exception 'This token migration does not record deposits (status %)', m.status using errcode = '23514';
    end if;
    if m.opened_slot is null or new.deposit_slot < m.opened_slot then
      raise exception 'A transfer from before the token migration opened is not a deposit' using errcode = '23514';
    end if;
    if new.status not in ('accepted', 'irregular') or new.delivery_tx is not null or new.refund_tx is not null then
      raise exception 'A deposit is recorded as accepted or irregular' using errcode = '23514';
    end if;
    if new.status = 'accepted' then
      if m.status = 'cancelled' then
        raise exception 'A cancelled token migration accepts no deposit' using errcode = '23514';
      end if;
      if new.units_due * m.lot_base_units <> new.amount_base then
        raise exception 'An accepted deposit is a whole number of lots' using errcode = '23514';
      end if;
      select coalesce(sum(d.units_due), 0) into taken from public.token_migration_deposits d
        where d.migration_id = m.id and d.status in ('accepted', 'delivered');
      if taken + new.units_due > m.units_cap then
        raise exception 'The units cap of this token migration is reached' using errcode = '23514';
      end if;
    end if;
    new.delivered_at := null;
    new.refunded_at := null;
    new.created_at := pg_catalog.clock_timestamp();
    new.updated_at := new.created_at;
    return new;
  end if;

  if (new.id, new.migration_id, new.network, new.holder_wallet, new.deposit_tx, new.deposit_slot, new.block_time,
      new.amount_base, new.units_due, new.recorded_via, new.created_at)
     is distinct from
     (old.id, old.migration_id, old.network, old.holder_wallet, old.deposit_tx, old.deposit_slot, old.block_time,
      old.amount_base, old.units_due, old.recorded_via, old.created_at) then
    raise exception 'What the chain proved about a deposit never changes' using errcode = '23514';
  end if;
  if new.status is distinct from old.status then
    if not (
      (old.status = 'accepted' and new.status = 'delivered' and m.status in ('open', 'closed')) or
      (old.status = 'accepted' and new.status = 'refunded' and m.status = 'cancelled') or
      (old.status = 'irregular' and new.status = 'refunded' and m.status in ('open', 'closed', 'cancelled'))
    ) then
      raise exception 'illegal token migration deposit transition: % -> % (campaign %)', old.status, new.status, m.status
        using errcode = '23514';
    end if;
    if new.status = 'delivered' then new.delivered_at := pg_catalog.clock_timestamp(); end if;
    if new.status = 'refunded' then new.refunded_at := pg_catalog.clock_timestamp(); end if;
  elsif (new.reason_code, new.reason, new.delivery_tx, new.refund_tx, new.delivered_at, new.refunded_at)
        is distinct from (old.reason_code, old.reason, old.delivery_tx, old.refund_tx, old.delivered_at, old.refunded_at) then
    raise exception 'A deposit changes only with its status' using errcode = '23514';
  end if;
  if new.status = 'refunded' and old.status = 'irregular' and new.reason_code is distinct from old.reason_code then
    raise exception 'A refund keeps the reason it was due for' using errcode = '23514';
  end if;
  if new.refund_tx is not null and old.refund_tx is null and exists (
    select 1 from public.token_migration_deposits d
    where d.network = new.network and d.refund_tx = new.refund_tx and d.id <> new.id
      and (d.migration_id <> new.migration_id or d.holder_wallet <> new.holder_wallet)
  ) then
    raise exception 'A refund transaction returns deposits of one holder of one campaign' using errcode = '23514';
  end if;
  new.updated_at := greatest(pg_catalog.clock_timestamp(), old.updated_at + interval '1 microsecond');
  return new;
end;
$$;
revoke all on function public.token_migration_deposits_guard() from public, anon, authenticated, service_role;
drop trigger if exists token_migration_deposits_guard on public.token_migration_deposits;
create trigger token_migration_deposits_guard before insert or update or delete on public.token_migration_deposits
  for each row execute function public.token_migration_deposits_guard();

-- ── 5. Recording a deposit (the one insert path) ──────────────────────────
-- The route verified the finalized transaction (lib/token-migration/
-- evidence.ts) and classified it: p_reason_code null = accepted with
-- p_lots lots, else irregular. Here, under the campaign row's lock: a
-- signature already recorded returns its row (idempotent; refused when it
-- belongs to another campaign); a transfer from before the opening slot is
-- refused (it is not this campaign's deposit); a cancelled campaign records
-- irregular 'not_open'; an accepted deposit that would pass the units cap is
-- recorded irregular 'over_cap' instead (refund due), never refused, because
-- the tokens already sit in the deposit account and must be accounted for.
-- Amounts come back as text (no JSON number above 2^53).
create or replace function public.record_token_migration_deposit(
  p_migration_id uuid,
  p_holder_wallet text,
  p_deposit_tx text,
  p_deposit_slot bigint,
  p_block_time timestamptz,
  p_amount_base numeric,
  p_lots numeric,
  p_reason_code text,
  p_reason text,
  p_recorded_via text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m record;
  existing public.token_migration_deposits%rowtype;
  inserted public.token_migration_deposits%rowtype;
  v_status text;
  v_units numeric;
  v_reason_code text := p_reason_code;
  v_reason text := p_reason;
  taken numeric;
begin
  if p_migration_id is null or p_holder_wallet is null or p_deposit_tx is null or p_deposit_slot is null
     or p_block_time is null or p_amount_base is null or p_amount_base < 1 or p_recorded_via not in ('holder', 'reconcile')
     or (p_reason_code is null and (p_lots is null or p_lots < 1)) then
    raise exception 'INVALID_DEPOSIT_ARGUMENTS' using errcode = '22023';
  end if;
  select t.id, t.network, t.status, t.units_cap, t.lot_base_units, t.opened_slot into m
    from public.token_migrations t
    where t.id = p_migration_id and t.network = public.deployment_network()
    for update;
  if not found then
    raise exception 'MIGRATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  select * into existing from public.token_migration_deposits d
    where d.network = m.network and d.deposit_tx = p_deposit_tx;
  if found then
    if existing.migration_id <> m.id then
      raise exception 'DEPOSIT_TX_OTHER_MIGRATION' using errcode = 'P0001';
    end if;
    return jsonb_build_object('created', false, 'id', existing.id, 'status', existing.status,
      'reason_code', existing.reason_code, 'units_due', existing.units_due::text);
  end if;
  if m.status not in ('open', 'closed', 'cancelled') then
    raise exception 'MIGRATION_NOT_RECORDING' using errcode = 'P0001';
  end if;
  if m.opened_slot is null or p_deposit_slot < m.opened_slot then
    raise exception 'DEPOSIT_BEFORE_OPENING' using errcode = 'P0001';
  end if;
  if v_reason_code is null then
    if p_lots * m.lot_base_units <> p_amount_base then
      raise exception 'INVALID_DEPOSIT_ARGUMENTS' using errcode = '22023';
    end if;
    v_status := 'accepted';
    v_units := p_lots;
    if m.status = 'cancelled' then
      v_status := 'irregular';
      v_reason_code := 'not_open';
      v_reason := 'The campaign was cancelled: refund it.';
    else
      select coalesce(sum(d.units_due), 0) into taken from public.token_migration_deposits d
        where d.migration_id = m.id and d.status in ('accepted', 'delivered');
      if taken + p_lots > m.units_cap then
        v_status := 'irregular';
        v_reason_code := 'over_cap';
        v_reason := 'The units cap was already reached when it was recorded: refund it.';
      end if;
    end if;
  else
    v_status := 'irregular';
  end if;
  if v_status = 'irregular' then v_units := 0; end if;
  insert into public.token_migration_deposits
    (migration_id, network, holder_wallet, deposit_tx, deposit_slot, block_time, amount_base, units_due,
     status, reason_code, reason, recorded_via)
  values
    (m.id, m.network, p_holder_wallet, p_deposit_tx, p_deposit_slot, p_block_time, p_amount_base, v_units,
     v_status, v_reason_code, left(v_reason, 500), p_recorded_via)
  returning * into inserted;
  return jsonb_build_object('created', true, 'id', inserted.id, 'status', inserted.status,
    'reason_code', inserted.reason_code, 'units_due', inserted.units_due::text);
end;
$$;
revoke all on function public.record_token_migration_deposit(uuid, text, text, bigint, timestamptz, numeric, numeric, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_token_migration_deposit(uuid, text, text, bigint, timestamptz, numeric, numeric, text, text, text)
  to service_role;

-- ── 6. Recording a delivery ───────────────────────────────────────────────
-- The route verified that the finalized transaction moved exactly the units
-- these deposits owe from the treasury to their holders
-- (lib/token-migration/evidence.ts deliveryEvidence). Here, atomically:
-- the signature is locked (an advisory lock: two requests with the same
-- signature run one after the other, whatever campaign they name), a
-- signature already recorded for exactly these deposits answers "already"
-- (idempotent), one recorded for any other deposit is refused, and every
-- listed deposit must be accepted in this campaign, or nothing is written.
create or replace function public.record_token_migration_delivery(
  p_migration_id uuid,
  p_delivery_tx text,
  p_deposit_ids uuid[]
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m record;
  requested uuid[];
  recorded uuid[];
  changed integer;
begin
  if p_migration_id is null or p_delivery_tx is null or p_delivery_tx !~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$'
     or p_deposit_ids is null or cardinality(p_deposit_ids) not between 1 and 100 then
    raise exception 'INVALID_DELIVERY_ARGUMENTS' using errcode = '22023';
  end if;
  select array_agg(x order by x) into requested from (select distinct unnest(p_deposit_ids) as x) ids;
  if cardinality(requested) <> cardinality(p_deposit_ids) then
    raise exception 'INVALID_DELIVERY_ARGUMENTS' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('token_migration_delivery:' || p_delivery_tx, 0));
  select t.id, t.network, t.status into m
    from public.token_migrations t
    where t.id = p_migration_id and t.network = public.deployment_network()
    for update;
  if not found then
    raise exception 'MIGRATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  select array_agg(d.id order by d.id) into recorded from public.token_migration_deposits d
    where d.network = m.network and d.delivery_tx = p_delivery_tx;
  if recorded is not null then
    if recorded = requested then
      return jsonb_build_object('created', false, 'count', cardinality(recorded));
    end if;
    raise exception 'DELIVERY_TX_ALREADY_RECORDED' using errcode = 'P0001';
  end if;
  if m.status not in ('open', 'closed') then
    raise exception 'MIGRATION_NOT_DELIVERING' using errcode = 'P0001';
  end if;
  update public.token_migration_deposits d set status = 'delivered', delivery_tx = p_delivery_tx
    where d.migration_id = m.id and d.id = any(requested) and d.status = 'accepted';
  get diagnostics changed = row_count;
  if changed <> cardinality(requested) then
    raise exception 'DELIVERY_DEPOSITS_NOT_ACCEPTED' using errcode = 'P0001';
  end if;
  return jsonb_build_object('created', true, 'count', changed);
end;
$$;
revoke all on function public.record_token_migration_delivery(uuid, text, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.record_token_migration_delivery(uuid, text, uuid[]) to service_role;

-- ── 7. Recording a refund ─────────────────────────────────────────────────
-- The route verified that the finalized transaction returned exactly these
-- deposits' total from the deposit account to the wallet that made them
-- (lib/token-migration/evidence.ts refundEvidence). Here, atomically and like
-- a delivery: the signature is locked; one already recorded for exactly
-- these deposits answers "already", one recorded for any other deposit is
-- refused; every listed deposit must be refundable in this campaign
-- (irregular, or accepted in a cancelled campaign) and belong to ONE holder,
-- or nothing is written. One transaction can so settle a holder's many small
-- irregular deposits at once.
create or replace function public.record_token_migration_refund(
  p_migration_id uuid,
  p_refund_tx text,
  p_deposit_ids uuid[]
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m record;
  requested uuid[];
  recorded uuid[];
  holders integer;
  changed integer;
begin
  if p_migration_id is null or p_refund_tx is null or p_refund_tx !~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$'
     or p_deposit_ids is null or cardinality(p_deposit_ids) not between 1 and 100 then
    raise exception 'INVALID_REFUND_ARGUMENTS' using errcode = '22023';
  end if;
  select array_agg(x order by x) into requested from (select distinct unnest(p_deposit_ids) as x) ids;
  if cardinality(requested) <> cardinality(p_deposit_ids) then
    raise exception 'INVALID_REFUND_ARGUMENTS' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('token_migration_refund:' || p_refund_tx, 0));
  select t.id, t.network, t.status into m
    from public.token_migrations t
    where t.id = p_migration_id and t.network = public.deployment_network()
    for update;
  if not found then
    raise exception 'MIGRATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  select array_agg(d.id order by d.id) into recorded from public.token_migration_deposits d
    where d.network = m.network and d.refund_tx = p_refund_tx;
  if recorded is not null then
    if recorded = requested then
      return jsonb_build_object('created', false, 'count', cardinality(recorded));
    end if;
    raise exception 'REFUND_TX_ALREADY_RECORDED' using errcode = 'P0001';
  end if;
  if m.status not in ('open', 'closed', 'cancelled') then
    raise exception 'MIGRATION_NOT_REFUNDING' using errcode = 'P0001';
  end if;
  select count(distinct d.holder_wallet) into holders from public.token_migration_deposits d
    where d.migration_id = m.id and d.id = any(requested);
  if holders <> 1 then
    raise exception 'REFUND_DEPOSITS_NOT_REFUNDABLE' using errcode = 'P0001';
  end if;
  update public.token_migration_deposits d set status = 'refunded', refund_tx = p_refund_tx
    where d.migration_id = m.id and d.id = any(requested)
      and (d.status = 'irregular' or (d.status = 'accepted' and m.status = 'cancelled'));
  get diagnostics changed = row_count;
  if changed <> cardinality(requested) then
    raise exception 'REFUND_DEPOSITS_NOT_REFUNDABLE' using errcode = 'P0001';
  end if;
  return jsonb_build_object('created', true, 'count', changed);
end;
$$;
revoke all on function public.record_token_migration_refund(uuid, text, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.record_token_migration_refund(uuid, text, uuid[]) to service_role;

select mancipatio_ops.install_network_guards();

commit;
