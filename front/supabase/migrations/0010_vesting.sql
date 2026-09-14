-- 0010_vesting.sql
-- Vesting schedule persistence. The curve builder used to live entirely in
-- React state; this set of tables lets issuers save a schedule + its
-- beneficiaries, track which milestones have been published on-chain, and
-- record per-beneficiary claims.
--
-- Shape mirrors what the on-chain rights program expects:
--   schedule → milestones → (Merkle root over beneficiaries per milestone)
--   beneficiaries → claims (one per milestone)
--
-- v0.1 stores the same Merkle root for every milestone in a schedule (the
-- beneficiary set is fixed). When we add re-snapshotting between milestones
-- we'll add `merkle_root` per milestone and stop reading it off the schedule.

create table if not exists public.vesting_schedules (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- What is vesting. asset_label is denormalised for list views.
  asset_mint      text not null,
  asset_label     text not null default '',
  rights_token    text,                          -- on-chain rights mint (optional until published)

  title           text not null,                 -- "Founder vesting", "Q4 team grants"
  description     text not null default '',

  -- Curve config — kept so we can re-derive milestones if we ever rebuild.
  curve           text not null
    check (curve in ('cliff', 'linear', 'step', 'custom')),
  total_amount    numeric(36, 0) not null,       -- integer base units
  start_date      date,
  duration_months integer,
  step_count      integer,
  step_interval_months integer,
  cliff_date      date,
  curve_config    jsonb not null default '{}'::jsonb,  -- extras / future-proofing

  -- Merkle.
  merkle_root     text,                          -- hex, snapshot over beneficiaries
  merkle_built_at timestamptz,

  status          text not null default 'draft'
    check (status in ('draft', 'beneficiaries_set', 'merkle_built',
                      'published', 'live', 'completed', 'cancelled')),

  notes           text not null default '',
  author          text not null                  -- issuer / admin wallet
);

create index if not exists vesting_schedules_asset_idx   on public.vesting_schedules (asset_mint);
create index if not exists vesting_schedules_author_idx  on public.vesting_schedules (author);
create index if not exists vesting_schedules_status_idx  on public.vesting_schedules (status);

create trigger vesting_schedules_touch before update on public.vesting_schedules
  for each row execute function public.touch_updated_at();

alter table public.vesting_schedules enable row level security;

drop policy if exists "vesting_schedules anon read"   on public.vesting_schedules;
create policy "vesting_schedules anon read"
  on public.vesting_schedules for select using (true);

drop policy if exists "vesting_schedules anon insert" on public.vesting_schedules;
create policy "vesting_schedules anon insert"
  on public.vesting_schedules for insert with check (true);

drop policy if exists "vesting_schedules anon update" on public.vesting_schedules;
create policy "vesting_schedules anon update"
  on public.vesting_schedules for update using (true) with check (true);

drop policy if exists "vesting_schedules anon delete" on public.vesting_schedules;
create policy "vesting_schedules anon delete"
  on public.vesting_schedules for delete using (true);

------------------------------------------------------------------------------
-- Per-milestone row. `idx` is the milestone index used by the on-chain
-- publish ix; we keep the unlock_date so claim UI can grey-out future
-- milestones without doing date math on the schedule curve.

create table if not exists public.vesting_milestones (
  schedule_id   uuid not null references public.vesting_schedules (id) on delete cascade,
  idx           integer not null,
  unlock_date   date not null,
  amount        numeric(36, 0) not null,
  published     boolean not null default false,
  published_at  timestamptz,
  published_tx  text,
  primary key (schedule_id, idx)
);

create index if not exists vesting_milestones_published_idx
  on public.vesting_milestones (schedule_id, published);

alter table public.vesting_milestones enable row level security;

drop policy if exists "vesting_milestones anon read"   on public.vesting_milestones;
create policy "vesting_milestones anon read"
  on public.vesting_milestones for select using (true);

drop policy if exists "vesting_milestones anon insert" on public.vesting_milestones;
create policy "vesting_milestones anon insert"
  on public.vesting_milestones for insert with check (true);

drop policy if exists "vesting_milestones anon update" on public.vesting_milestones;
create policy "vesting_milestones anon update"
  on public.vesting_milestones for update using (true) with check (true);

drop policy if exists "vesting_milestones anon delete" on public.vesting_milestones;
create policy "vesting_milestones anon delete"
  on public.vesting_milestones for delete using (true);

------------------------------------------------------------------------------
-- Beneficiary entitlement. The set is shared by every milestone in the
-- schedule (one Merkle root for the whole schedule, scaled per milestone
-- by the on-chain program).

create table if not exists public.vesting_beneficiaries (
  schedule_id   uuid not null references public.vesting_schedules (id) on delete cascade,
  wallet        text not null,
  entitlement   numeric(36, 0) not null,            -- absolute units across the curve
  merkle_index  integer not null,
  merkle_proof  jsonb not null default '[]'::jsonb, -- hex sibling hashes
  primary key (schedule_id, wallet)
);

create index if not exists vesting_beneficiaries_wallet_idx
  on public.vesting_beneficiaries (wallet);

alter table public.vesting_beneficiaries enable row level security;

drop policy if exists "vesting_beneficiaries anon read"   on public.vesting_beneficiaries;
create policy "vesting_beneficiaries anon read"
  on public.vesting_beneficiaries for select using (true);

drop policy if exists "vesting_beneficiaries anon insert" on public.vesting_beneficiaries;
create policy "vesting_beneficiaries anon insert"
  on public.vesting_beneficiaries for insert with check (true);

drop policy if exists "vesting_beneficiaries anon update" on public.vesting_beneficiaries;
create policy "vesting_beneficiaries anon update"
  on public.vesting_beneficiaries for update using (true) with check (true);

drop policy if exists "vesting_beneficiaries anon delete" on public.vesting_beneficiaries;
create policy "vesting_beneficiaries anon delete"
  on public.vesting_beneficiaries for delete using (true);

------------------------------------------------------------------------------
-- Claim ledger. One row per (schedule, milestone, wallet). The on-chain
-- claim ix is the source of truth for `claimed_tx` — this row gets written
-- by the indexer or by the claim UI as a fire-and-forget acknowledgement.

create table if not exists public.vesting_claims (
  schedule_id   uuid not null,
  milestone_idx integer not null,
  wallet        text not null,
  amount        numeric(36, 0) not null,
  claimed_at    timestamptz not null default now(),
  claimed_tx    text,
  primary key (schedule_id, milestone_idx, wallet),
  foreign key (schedule_id, milestone_idx)
    references public.vesting_milestones (schedule_id, idx) on delete cascade
);

create index if not exists vesting_claims_wallet_idx
  on public.vesting_claims (wallet);
create index if not exists vesting_claims_schedule_idx
  on public.vesting_claims (schedule_id);

alter table public.vesting_claims enable row level security;

drop policy if exists "vesting_claims anon read"   on public.vesting_claims;
create policy "vesting_claims anon read"
  on public.vesting_claims for select using (true);

drop policy if exists "vesting_claims anon insert" on public.vesting_claims;
create policy "vesting_claims anon insert"
  on public.vesting_claims for insert with check (true);

drop policy if exists "vesting_claims anon update" on public.vesting_claims;
create policy "vesting_claims anon update"
  on public.vesting_claims for update using (true) with check (true);

drop policy if exists "vesting_claims anon delete" on public.vesting_claims;
create policy "vesting_claims anon delete"
  on public.vesting_claims for delete using (true);
