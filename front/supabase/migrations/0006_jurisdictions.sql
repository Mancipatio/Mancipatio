-- 0006_jurisdictions.sql
-- Per-jurisdiction compliance configuration: KYC level, asset types,
-- risk tier, sale / OTC / claim toggles. ISO-3166 numeric code is the PK.

create table if not exists public.jurisdictions (
  code              text primary key,        -- ISO-3166 numeric (e.g. "688")
  name              text not null,
  alpha2            text,
  region            text,
  enabled_sale      boolean not null default true,
  enabled_otc       boolean not null default true,
  enabled_claim     boolean not null default true,
  kyc_level         text not null default 'basic'
    check (kyc_level in ('none', 'basic', 'enhanced', 'kyb')),
  risk_tier         text not null default 'medium'
    check (risk_tier in ('low', 'medium', 'high', 'prohibited')),
  -- Asset types allowed (subset of Mancipatio asset types).
  -- Empty array = all allowed. Use codes: equity, debt, real_estate, royalty,
  -- revenue_share, commodity, physical, other
  allowed_asset_types jsonb not null default '[]'::jsonb,
  notes             text not null default '',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists jurisdictions_risk_idx on public.jurisdictions (risk_tier);
create index if not exists jurisdictions_kyc_idx on public.jurisdictions (kyc_level);

create trigger jurisdictions_touch before update on public.jurisdictions
  for each row execute function public.touch_updated_at();

alter table public.jurisdictions enable row level security;

drop policy if exists "jurisdictions anon read"   on public.jurisdictions;
create policy "jurisdictions anon read"
  on public.jurisdictions for select using (true);

drop policy if exists "jurisdictions anon insert" on public.jurisdictions;
create policy "jurisdictions anon insert"
  on public.jurisdictions for insert with check (true);

drop policy if exists "jurisdictions anon update" on public.jurisdictions;
create policy "jurisdictions anon update"
  on public.jurisdictions for update using (true) with check (true);

drop policy if exists "jurisdictions anon delete" on public.jurisdictions;
create policy "jurisdictions anon delete"
  on public.jurisdictions for delete using (true);

------------------------------------------------------------------------------
-- Seed a handful of jurisdictions we expect to see early.
-- Existing rows are left alone (idempotent).
------------------------------------------------------------------------------
insert into public.jurisdictions (code, name, alpha2, region, enabled_sale, enabled_otc, enabled_claim, kyc_level, risk_tier, notes)
values
  ('688', 'Serbia',                 'RS', 'Europe',         true, true, true, 'basic',    'medium', 'Domicile of platform operator'),
  ('070', 'Bosnia and Herzegovina', 'BA', 'Europe',         true, true, true, 'basic',    'medium', ''),
  ('499', 'Montenegro',             'ME', 'Europe',         true, true, true, 'basic',    'medium', ''),
  ('191', 'Croatia',                'HR', 'Europe',         true, true, true, 'enhanced', 'low',    'EU member — MiCA applies'),
  ('276', 'Germany',                'DE', 'Europe',         true, true, true, 'enhanced', 'low',    'EU member — MiCA applies'),
  ('826', 'United Kingdom',         'GB', 'Europe',         true, true, true, 'enhanced', 'low',    'FCA — review case-by-case'),
  ('840', 'United States',          'US', 'North America', false, false, false, 'kyb',     'high',   'Securities law — disabled until Reg D / Reg S workflow'),
  ('784', 'United Arab Emirates',   'AE', 'Asia',           true, true, true, 'enhanced', 'low',    'VARA jurisdiction'),
  ('222', 'El Salvador',            'SV', 'North America', true, true, true, 'basic',    'low',    'Domicile target per strategy'),
  ('408', 'North Korea',            'KP', 'Asia',          false, false, false, 'none',    'prohibited', 'OFAC sanctioned'),
  ('364', 'Iran',                   'IR', 'Asia',          false, false, false, 'none',    'prohibited', 'OFAC sanctioned'),
  ('192', 'Cuba',                   'CU', 'North America', false, false, false, 'none',    'prohibited', 'OFAC sanctioned'),
  ('760', 'Syria',                  'SY', 'Asia',          false, false, false, 'none',    'prohibited', 'OFAC sanctioned')
on conflict (code) do nothing;
