-- 0014_asset_profiles.sql
-- Off-chain, per-category product metadata for each on-chain Asset.
-- The on-chain Asset is deliberately generic (asset_type enum + legal_doc_hash),
-- so the category-specific product fields (coupon/maturity, SPV/sqm/income share,
-- royalty rate, revenue %, storage proof, custodian, …) live here, keyed by the
-- asset PDA (= public.assets.pda). This is the "custom metadata pointer" the
-- platform's taxonomy promises.
--
-- RLS posture follows the existing v0.1 pattern (anon read + write). Tighten in the
-- T7 server-route migration (see docs/2026-06-22-overnight-audit.md).

create table if not exists public.asset_profiles (
  asset_pda        text primary key,                 -- = public.assets.pda
  network          text not null default 'devnet',
  issuer_pda       text,
  category         text not null check (category in
    ('equity','revenue_share','royalty','real_estate',
     'debt','commodity','physical','other')),

  -- common (all categories)
  display_name     text,
  summary          text,
  description      text,
  cover_image_path text,
  logo_letter      text,
  logo_gradient    text,
  website          text,
  legal_doc_path   text,
  legal_doc_sha256 text,                             -- mirrors on-chain legal_doc_hash
  jurisdiction     text,                             -- ISO numeric code
  tags             jsonb not null default '[]'::jsonb,
  status           text not null default 'draft'
                     check (status in ('draft','published','archived')),
  is_published     boolean not null default false,

  -- equity
  pre_money_valuation numeric,
  share_price         numeric,
  total_shares        numeric,
  liquidation_pref_bps integer,
  has_voting          boolean,
  dividend_policy     text,
  convertible         boolean,
  cap_table_doc_path  text,
  round_series        text,

  -- revenue_share
  revenue_pct_bps     integer,
  revenue_basis       text check (revenue_basis is null or revenue_basis in ('gross','net')),
  cap_multiple        numeric,
  trigger_threshold   numeric,
  measurement_period  text,
  reporting_cadence   text,

  -- royalty
  royalty_rate_bps    integer,
  underlying_contract text,
  ip_description      text,
  revenue_source      text,
  payment_frequency   text,
  termination_date    date,
  territory           text,
  historical_revenue  text,

  -- real_estate
  spv_reference       text,
  address             text,
  square_meters       numeric,
  valuation           numeric,
  appraisal_date      date,
  income_share_bps    integer,
  occupancy_pct       numeric,
  property_doc_path   text,
  kyb_gated           boolean default true,

  -- debt
  principal           numeric,
  coupon_rate_bps     integer,
  coupon_frequency    text,
  maturity_date       date,
  seniority           text,
  default_trigger     text,
  collateral_desc     text,

  -- commodity
  underlying          text,
  unit                text,
  quantity            numeric,
  storage_provider    text,
  storage_location    text,
  storage_proof_ref   text,
  settlement_window   text,
  assay_doc_path      text,

  -- physical
  item_description    text,
  custodian           text,
  custody_location    text,
  insurance_policy_ref text,
  insurance_coverage  text,
  appraised_value     numeric,
  inspection_cadence  text,
  condition_report_path text,

  -- other / forward-compat overflow
  custom_metadata_uri text,
  schema_label        text,
  fields              jsonb not null default '{}'::jsonb,

  -- bookkeeping
  created_by          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists asset_profiles_net_cat_idx  on public.asset_profiles (network, category);
create index if not exists asset_profiles_issuer_idx    on public.asset_profiles (issuer_pda);
create index if not exists asset_profiles_published_idx  on public.asset_profiles (is_published) where is_published;

drop trigger if exists asset_profiles_touch on public.asset_profiles;
create trigger asset_profiles_touch before update on public.asset_profiles
  for each row execute function public.touch_updated_at();

alter table public.asset_profiles enable row level security;

drop policy if exists "asset_profiles anon read"   on public.asset_profiles;
drop policy if exists "asset_profiles anon insert" on public.asset_profiles;
drop policy if exists "asset_profiles anon update" on public.asset_profiles;
drop policy if exists "asset_profiles anon delete" on public.asset_profiles;

create policy "asset_profiles anon read"
  on public.asset_profiles for select using (true);
create policy "asset_profiles anon insert"
  on public.asset_profiles for insert with check (true);
create policy "asset_profiles anon update"
  on public.asset_profiles for update using (true) with check (true);
create policy "asset_profiles anon delete"
  on public.asset_profiles for delete using (true);
