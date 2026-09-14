-- 0012_equity_launch.sql — Equity Launch off-chain tables (apply / listing / updates / commitments)
-- RLS open (v0.1) to match existing tables; tighten behind SIWS later (tracked in plan-doc).

create table if not exists public.launch_applications (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  applicant_wallet text not null,
  raise_type text not null check (raise_type in ('startup','mature')),
  company_name text not null,
  one_liner text not null,
  website text,
  category text not null,
  stage text,
  incorporation text,
  valuation text,
  annual_revenue text,
  existing_investors text,
  problem_or_why text,
  raise_amount numeric not null,
  equity_offered numeric not null,
  min_ticket text,
  raise_structure text,
  cliff_months int not null default 0,
  vesting_months int not null default 0,
  founder_name text,
  founder_email text,
  founder_twitter text,
  founder_linkedin text,
  founder_why text,
  pitch_deck text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  review_reason text,
  reviewed_by text,
  reviewed_at timestamptz,
  linked_issuer text,
  linked_sale_pubkey text
);

create table if not exists public.launch_listings (
  sale_pubkey text primary key,
  application_id uuid references public.launch_applications(id),
  created_at timestamptz not null default now(),
  logo_letter text,
  logo_gradient text,
  problem text,
  why_now text,
  traction jsonb not null default '{}'::jsonb,
  existing_investors text,
  is_published boolean not null default true
);

create table if not exists public.launch_updates (
  id uuid primary key default gen_random_uuid(),
  sale_pubkey text not null,
  posted_at timestamptz not null default now(),
  title text not null,
  body text not null,
  onchain_update_index int
);

create table if not exists public.commitments (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  sale_pubkey text not null,
  investor_wallet text not null,
  amount numeric not null,
  status text not null default 'pending' check (status in ('pending','confirmed','settled','cancelled')),
  settled_tx text
);

create index if not exists launch_applications_status_idx on public.launch_applications(status);
create index if not exists launch_updates_sale_idx on public.launch_updates(sale_pubkey);
create index if not exists commitments_sale_idx on public.commitments(sale_pubkey);

alter table public.launch_applications enable row level security;
alter table public.launch_listings    enable row level security;
alter table public.launch_updates     enable row level security;
alter table public.commitments         enable row level security;

do $$
begin
  perform 1;
  create policy launch_applications_all on public.launch_applications for all using (true) with check (true);
  create policy launch_listings_all    on public.launch_listings    for all using (true) with check (true);
  create policy launch_updates_all     on public.launch_updates     for all using (true) with check (true);
  create policy commitments_all         on public.commitments         for all using (true) with check (true);
exception when duplicate_object then null;
end $$;
