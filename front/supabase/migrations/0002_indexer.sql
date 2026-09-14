-- 0002_indexer.sql
-- Indexer tables for on-chain entities — written from the Helius webhook
-- Edge Function on every relevant transaction. All admin lists read from
-- these tables instead of getProgramAccounts (faster + scales past 1k rows).
--
-- v0.1: open RLS for SELECT (read everything with anon key). Writes are
-- gated to the service_role only — no anon INSERT/UPDATE/DELETE policies
-- are defined, so RLS denies them by default.

create extension if not exists "pgcrypto";

------------------------------------------------------------------------------
-- shared helpers
------------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

------------------------------------------------------------------------------
-- platforms (singleton, but kept as a table for symmetry)
------------------------------------------------------------------------------
create table if not exists public.platforms (
  pda                text primary key,
  network            text not null default 'devnet',
  admin              text not null,
  protocol_treasury  text not null,
  protocol_fee_bps   integer not null,
  paused             boolean not null default false,
  issuers_count      bigint not null default 0,
  version            integer not null,
  raw                jsonb not null default '{}'::jsonb,
  last_signature     text,
  last_slot          bigint,
  updated_at         timestamptz not null default now()
);
create trigger platforms_touch before update on public.platforms
  for each row execute function public.touch_updated_at();

------------------------------------------------------------------------------
-- issuers
------------------------------------------------------------------------------
create table if not exists public.issuers (
  pda                text primary key,
  network            text not null default 'devnet',
  authority          text not null,
  legal_entity_id    text not null,
  jurisdiction       integer not null,
  kyb_status         integer not null,
  kyb_doc_hash       text not null,
  assets_count       integer not null default 0,
  raw                jsonb not null default '{}'::jsonb,
  last_signature     text,
  last_slot          bigint,
  updated_at         timestamptz not null default now()
);
create index if not exists issuers_authority_idx on public.issuers (authority);
create index if not exists issuers_kyb_status_idx on public.issuers (kyb_status);
create index if not exists issuers_network_idx on public.issuers (network);
create trigger issuers_touch before update on public.issuers
  for each row execute function public.touch_updated_at();

------------------------------------------------------------------------------
-- assets
------------------------------------------------------------------------------
create table if not exists public.assets (
  pda                  text primary key,
  network              text not null default 'devnet',
  issuer_pda           text not null,
  asset_id             text not null,
  asset_type           integer not null,
  name                 text not null default '',
  symbol_prefix        text not null default '',
  legal_doc_hash       text not null default '',
  status               integer not null default 0,
  share_classes_count  integer not null default 0,
  raw                  jsonb not null default '{}'::jsonb,
  last_signature       text,
  last_slot            bigint,
  updated_at           timestamptz not null default now()
);
create index if not exists assets_issuer_idx on public.assets (issuer_pda);
create index if not exists assets_type_idx on public.assets (asset_type);
create index if not exists assets_network_idx on public.assets (network);
create trigger assets_touch before update on public.assets
  for each row execute function public.touch_updated_at();

------------------------------------------------------------------------------
-- share_classes
------------------------------------------------------------------------------
create table if not exists public.share_classes (
  pda                    text primary key,
  network                text not null default 'devnet',
  asset_pda              text not null,
  mint                   text not null,
  class_index            integer not null,
  class_type             integer not null,
  rights_bitfield        integer not null default 0,
  liq_pref_multi_bps     integer not null default 10000,
  liq_seniority          integer not null default 0,
  voting_weight          integer not null default 0,
  max_supply             numeric,
  circulating_supply     numeric not null default 0,
  locked_supply          numeric not null default 0,
  mintable_post_launch   boolean not null default false,
  mint_initialized       boolean not null default false,
  supply_locked          boolean not null default false,
  raw                    jsonb not null default '{}'::jsonb,
  last_signature         text,
  last_slot              bigint,
  updated_at             timestamptz not null default now()
);
create index if not exists share_classes_asset_idx on public.share_classes (asset_pda);
create index if not exists share_classes_mint_idx on public.share_classes (mint);
create index if not exists share_classes_network_idx on public.share_classes (network);
create trigger share_classes_touch before update on public.share_classes
  for each row execute function public.touch_updated_at();

------------------------------------------------------------------------------
-- sales (primary launchpad)
------------------------------------------------------------------------------
create table if not exists public.sales (
  pda               text primary key,
  network           text not null default 'devnet',
  share_class_pda   text not null,
  mint              text not null,
  payment_mint      text not null,
  proceeds          text not null,
  authority         text not null,
  sale_id           numeric not null,
  price_per_unit    numeric not null,
  total_for_sale    numeric not null,
  sold              numeric not null default 0,
  start_ts          bigint not null default 0,
  end_ts            bigint not null default 0,
  status            integer not null default 0,
  raw               jsonb not null default '{}'::jsonb,
  last_signature    text,
  last_slot         bigint,
  updated_at        timestamptz not null default now()
);
create index if not exists sales_share_class_idx on public.sales (share_class_pda);
create index if not exists sales_status_idx on public.sales (status);
create index if not exists sales_network_idx on public.sales (network);
create trigger sales_touch before update on public.sales
  for each row execute function public.touch_updated_at();

------------------------------------------------------------------------------
-- custody_vaults
------------------------------------------------------------------------------
create table if not exists public.custody_vaults (
  pda              text primary key,
  network          text not null default 'devnet',
  share_class_pda  text not null,
  mint             text not null,
  escrow           text not null,
  vault_id         numeric not null,
  authority        text not null,
  vault_type       integer not null,
  realize_action   integer not null,
  amount           numeric not null default 0,
  state            integer not null default 0,
  deadline         bigint not null default 0,
  metadata_hash    text not null default '',
  raw              jsonb not null default '{}'::jsonb,
  last_signature   text,
  last_slot        bigint,
  updated_at       timestamptz not null default now()
);
create index if not exists custody_share_class_idx on public.custody_vaults (share_class_pda);
create index if not exists custody_state_idx on public.custody_vaults (state);
create index if not exists custody_network_idx on public.custody_vaults (network);
create trigger custody_touch before update on public.custody_vaults
  for each row execute function public.touch_updated_at();

------------------------------------------------------------------------------
-- offers (OTC)
------------------------------------------------------------------------------
create table if not exists public.offers (
  pda              text primary key,
  network          text not null default 'devnet',
  maker            text not null,
  share_class_pda  text not null,
  mint             text not null,
  escrow           text not null,
  payment_mint     text not null,
  amount           numeric not null,
  price            numeric not null,
  status           integer not null default 0,
  offer_id         numeric not null,
  raw              jsonb not null default '{}'::jsonb,
  last_signature   text,
  last_slot        bigint,
  updated_at       timestamptz not null default now()
);
create index if not exists offers_maker_idx on public.offers (maker);
create index if not exists offers_share_class_idx on public.offers (share_class_pda);
create index if not exists offers_status_idx on public.offers (status);
create index if not exists offers_network_idx on public.offers (network);
create trigger offers_touch before update on public.offers
  for each row execute function public.touch_updated_at();

------------------------------------------------------------------------------
-- proposals (governance)
------------------------------------------------------------------------------
create table if not exists public.proposals (
  pda              text primary key,
  network          text not null default 'devnet',
  share_class_pda  text not null,
  authority        text not null,
  proposal_id      numeric not null,
  metadata_hash    text not null default '',
  snapshot_slot    bigint not null default 0,
  snapshot_root    text not null default '',
  start_ts         bigint not null default 0,
  end_ts           bigint not null default 0,
  for_weight       numeric not null default 0,
  against_weight   numeric not null default 0,
  abstain_weight   numeric not null default 0,
  status           integer not null default 0,
  outcome          integer not null default 0,
  raw              jsonb not null default '{}'::jsonb,
  last_signature   text,
  last_slot        bigint,
  updated_at       timestamptz not null default now()
);
create index if not exists proposals_share_class_idx on public.proposals (share_class_pda);
create index if not exists proposals_status_idx on public.proposals (status);
create index if not exists proposals_network_idx on public.proposals (network);
create trigger proposals_touch before update on public.proposals
  for each row execute function public.touch_updated_at();

------------------------------------------------------------------------------
-- vote_records (per (proposal, voter))
------------------------------------------------------------------------------
create table if not exists public.vote_records (
  pda              text primary key,
  network          text not null default 'devnet',
  proposal_pda     text not null,
  voter            text not null,
  choice           integer not null,
  weight           numeric not null,
  raw              jsonb not null default '{}'::jsonb,
  last_signature   text,
  last_slot        bigint,
  updated_at       timestamptz not null default now()
);
create index if not exists vote_records_proposal_idx on public.vote_records (proposal_pda);
create index if not exists vote_records_voter_idx on public.vote_records (voter);
create index if not exists vote_records_network_idx on public.vote_records (network);
create trigger vote_records_touch before update on public.vote_records
  for each row execute function public.touch_updated_at();

------------------------------------------------------------------------------
-- rights_issuances + milestones + claims
------------------------------------------------------------------------------
create table if not exists public.rights_issuances (
  pda                text primary key,
  network            text not null default 'devnet',
  share_class_pda    text not null,
  underlying_mint    text not null,
  escrow             text not null,
  authority          text not null,
  issuance_id        numeric not null,
  total_claimed      numeric not null default 0,
  milestones_count   integer not null default 0,
  raw                jsonb not null default '{}'::jsonb,
  last_signature     text,
  last_slot          bigint,
  updated_at         timestamptz not null default now()
);
create index if not exists rights_share_class_idx on public.rights_issuances (share_class_pda);
create index if not exists rights_network_idx on public.rights_issuances (network);
create trigger rights_touch before update on public.rights_issuances
  for each row execute function public.touch_updated_at();

create table if not exists public.milestones (
  pda              text primary key,
  network          text not null default 'devnet',
  issuance_pda     text not null,
  index            integer not null,
  merkle_root      text not null default '',
  amount_pool      numeric not null default 0,
  claimed          numeric not null default 0,
  unlock_ts        bigint not null default 0,
  raw              jsonb not null default '{}'::jsonb,
  last_signature   text,
  last_slot        bigint,
  updated_at       timestamptz not null default now()
);
create index if not exists milestones_issuance_idx on public.milestones (issuance_pda);
create index if not exists milestones_network_idx on public.milestones (network);
create trigger milestones_touch before update on public.milestones
  for each row execute function public.touch_updated_at();

create table if not exists public.milestone_claims (
  pda              text primary key,
  network          text not null default 'devnet',
  milestone_pda    text not null,
  claimer          text not null,
  amount           numeric not null default 0,
  raw              jsonb not null default '{}'::jsonb,
  last_signature   text,
  last_slot        bigint,
  updated_at       timestamptz not null default now()
);
create index if not exists claims_milestone_idx on public.milestone_claims (milestone_pda);
create index if not exists claims_claimer_idx on public.milestone_claims (claimer);
create index if not exists claims_network_idx on public.milestone_claims (network);
create trigger claims_touch before update on public.milestone_claims
  for each row execute function public.touch_updated_at();

------------------------------------------------------------------------------
-- raw event log — every webhook delivery, regardless of decoder coverage.
-- Useful for debugging and for the audit log "what happened" panel.
------------------------------------------------------------------------------
create table if not exists public.indexer_events (
  id              bigserial primary key,
  created_at      timestamptz not null default now(),
  network         text not null default 'devnet',
  signature       text not null,
  slot            bigint,
  block_time      timestamptz,
  program         text,
  ix_name         text,
  decoded         boolean not null default false,
  payload         jsonb not null default '{}'::jsonb
);
create index if not exists indexer_events_signature_idx on public.indexer_events (signature);
create index if not exists indexer_events_created_at_idx on public.indexer_events (created_at desc);
create index if not exists indexer_events_network_idx on public.indexer_events (network);

------------------------------------------------------------------------------
-- RLS — read-public, write-service-role-only
------------------------------------------------------------------------------
alter table public.platforms        enable row level security;
alter table public.issuers          enable row level security;
alter table public.assets           enable row level security;
alter table public.share_classes    enable row level security;
alter table public.sales            enable row level security;
alter table public.custody_vaults   enable row level security;
alter table public.offers           enable row level security;
alter table public.proposals        enable row level security;
alter table public.vote_records     enable row level security;
alter table public.rights_issuances enable row level security;
alter table public.milestones       enable row level security;
alter table public.milestone_claims enable row level security;
alter table public.indexer_events   enable row level security;

do $$
declare
  t text;
begin
  for t in
    select unnest(array[
      'platforms','issuers','assets','share_classes','sales',
      'custody_vaults','offers','proposals','vote_records',
      'rights_issuances','milestones','milestone_claims','indexer_events'
    ])
  loop
    execute format(
      'drop policy if exists "%s anon read" on public.%I',
      t, t
    );
    execute format(
      'create policy "%s anon read" on public.%I for select using (true)',
      t, t
    );
  end loop;
end $$;
-- No INSERT/UPDATE/DELETE policies → only service_role can write.
