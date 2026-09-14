-- 0040_indexer_kyc.sql — indexer mirrors for the on-chain KYC accounts.
--
-- Pairs with the helius-webhook change that registers KycRegistry / KycEntry
-- decoders: every create_kyc_registry / approve_holder / revoke_holder tx now
-- upserts the touched accounts here, so admin KYC surfaces can read passport
-- state without getProgramAccounts scans.
--
-- DEPLOY ORDER: apply this migration (`supabase db push`) BEFORE deploying
-- the helius-webhook edge function. If the function ships first, it handles
-- the two "table missing" cases differently (classifyTableError there):
-- a Postgres 42P01 (table really absent) is logged and SKIPPED per entry so
-- one un-migrated table cannot stall every batch, while a PostgREST PGRST205
-- ("not in the schema cache" — the usual state for a few seconds after
-- `supabase db push`) is treated as TRANSIENT and retried for 15 minutes.
-- Rows still skipped after that are recovered by POST /api/admin/reconcile,
-- which REBUILDS kyc_registries / kyc_entries rows from chain bytes (an
-- already-approved KycEntry may never see another tx, so "the next tx
-- touching the PDA re-indexes it" is not a recovery path here).
--
-- Conventions (latest indexer generation, not the 0002 originals):
--   * composite primary key (network, pda) — migration 0038 — so devnet and
--     mainnet rows with the same PDA coexist (PDAs derive from program id +
--     seeds only, so addresses are identical across networks);
--   * last_slot column + the 0037 BEFORE UPDATE stale-write guard, so an
--     older snapshot never lands over a newer one on concurrent deliveries;
--   * raw / last_signature / updated_at + touch trigger like every other
--     indexer entity table.
--
-- RLS: enabled with NO policies at all (default-deny for anon AND
-- authenticated). On-chain KYC accounts are technically public ledger data,
-- but the admin UI reads every KYC surface through signed service-role
-- routes anyway, and an anon-readable passport table would hand out a bulk
-- "which wallets passed KYC in which jurisdiction" dataset for free —
-- against the 0031/0036 direction of adding no new anon SELECT surfaces.
-- The service role bypasses RLS, so the webhook writes and the signed admin
-- routes read without any policy here.
--
-- Idempotent.

-- ---------------------------------------------------------------------------
-- kyc_registries — one row per KycRegistry PDA (["kyc_registry", authority]).
-- ---------------------------------------------------------------------------
create table if not exists public.kyc_registries (
  pda                     text not null,
  network                 text not null default 'devnet',
  authority               text not null,
  approved_jurisdictions  text not null default '', -- 256-bit bitmap, hex
  blocked_jurisdictions   text not null default '', -- 256-bit bitmap, hex
  entries_count           bigint not null default 0,
  version                 integer not null default 0,
  raw                     jsonb not null default '{}'::jsonb,
  last_signature          text,
  last_slot               bigint,
  updated_at              timestamptz not null default now(),
  primary key (network, pda)
);
create index if not exists kyc_registries_authority_idx
  on public.kyc_registries (authority);
create index if not exists kyc_registries_network_idx
  on public.kyc_registries (network);

-- ---------------------------------------------------------------------------
-- kyc_entries — one row per KycEntry PDA (["kyc", registry, holder]).
-- ---------------------------------------------------------------------------
create table if not exists public.kyc_entries (
  pda                  text not null,
  network              text not null default 'devnet',
  registry_pda         text not null,
  holder               text not null,
  status               integer not null default 0, -- KycStatus: 0 Pending / 1 Approved / 2 Revoked / 3 Expired
  jurisdiction         integer not null default 0,
  accreditation_level  integer not null default 0,
  expiry               bigint not null default 0,  -- unix ts; entry is stale after this
  provider_id          integer not null default 0,
  external_ref_hash    text not null default '',   -- sha256 of the off-chain dossier ref, hex
  version              integer not null default 0,
  raw                  jsonb not null default '{}'::jsonb,
  last_signature       text,
  last_slot            bigint,
  updated_at           timestamptz not null default now(),
  primary key (network, pda)
);
create index if not exists kyc_entries_registry_idx
  on public.kyc_entries (registry_pda);
create index if not exists kyc_entries_holder_idx
  on public.kyc_entries (holder);
create index if not exists kyc_entries_status_idx
  on public.kyc_entries (status);
create index if not exists kyc_entries_network_idx
  on public.kyc_entries (network);

-- ---------------------------------------------------------------------------
-- Triggers: updated_at touch (0002 convention) + last_slot stale-write guard
-- (0037 convention — indexer_reject_stale_slot skips an update whose incoming
-- last_slot is behind the stored one).
-- ---------------------------------------------------------------------------
drop trigger if exists kyc_registries_touch on public.kyc_registries;
create trigger kyc_registries_touch before update on public.kyc_registries
  for each row execute function public.touch_updated_at();
drop trigger if exists kyc_entries_touch on public.kyc_entries;
create trigger kyc_entries_touch before update on public.kyc_entries
  for each row execute function public.touch_updated_at();

drop trigger if exists kyc_registries_reject_stale_slot on public.kyc_registries;
create trigger kyc_registries_reject_stale_slot
  before update on public.kyc_registries
  for each row execute function public.indexer_reject_stale_slot();
drop trigger if exists kyc_entries_reject_stale_slot on public.kyc_entries;
create trigger kyc_entries_reject_stale_slot
  before update on public.kyc_entries
  for each row execute function public.indexer_reject_stale_slot();

-- ---------------------------------------------------------------------------
-- RLS: default-deny. Deliberately NO policies (see header) — reads go through
-- service-role routes, writes come from the service-role webhook.
-- ---------------------------------------------------------------------------
alter table public.kyc_registries enable row level security;
alter table public.kyc_entries enable row level security;
