-- Self-service KYC (individual) and KYB (company) details submitted from
-- /verify. Private PII: service role only, no anon/authenticated access.
-- One row per dossier and kind; resubmitting replaces the details.
begin;

create table public.client_verification_details (
  client_id uuid not null references public.clients(id) on delete cascade,
  kind text not null check (kind in ('kyc','kyb')),
  -- Individual (KYC) or company representative (KYB).
  legal_name text not null check (length(legal_name) between 2 and 200),
  date_of_birth date check (date_of_birth between date '1900-01-01' and current_date),
  nationality smallint check (nationality between 1 and 999),
  residence_country smallint not null check (residence_country between 1 and 999),
  address_line text not null check (length(address_line) between 3 and 300),
  city text not null check (length(city) between 1 and 120),
  postal_code text not null check (length(postal_code) between 1 and 20),
  phone text check (length(phone) between 5 and 32),
  email text check (length(email) between 3 and 254),
  -- Company (KYB only).
  company_name text check (length(company_name) between 2 and 200),
  company_reg_number text check (length(company_reg_number) between 1 and 64),
  company_country smallint check (company_country between 1 and 999),
  company_address text check (length(company_address) between 3 and 300),
  company_website text check (length(company_website) <= 300),
  representative_role text check (length(representative_role) between 2 and 120),
  submitted_by_wallet text not null check (submitted_by_wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  submitted_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (client_id, kind),
  check (kind = 'kyb' or (date_of_birth is not null and nationality is not null)),
  check (kind = 'kyc' or (company_name is not null and company_reg_number is not null
    and company_country is not null and company_address is not null and representative_role is not null))
);
create trigger client_verification_details_touch before update on public.client_verification_details
  for each row execute function public.touch_updated_at();

alter table public.client_verification_details enable row level security;
revoke all on public.client_verification_details from public, anon, authenticated;
grant all on public.client_verification_details to service_role;

commit;
