-- 0013_clients_kyc.sql — multiple client types, more_info KYC state, KYC requirements checklist.

-- 1) Multiple types (additive; keep legacy `type` synced to types[0]).
alter table public.clients add column if not exists types jsonb not null default '[]'::jsonb;
update public.clients set types = jsonb_build_array(type) where types = '[]'::jsonb;

-- 2) Extend kyc_status with 'more_info'.
alter table public.clients drop constraint if exists clients_kyc_status_check;
alter table public.clients add constraint clients_kyc_status_check
  check (kyc_status in ('pending','verified','rejected','suspended','expired','more_info'));

-- 3) Structured KYC requirements checklist.
create table if not exists public.kyc_requirements (
  id            bigserial primary key,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  client_id     uuid not null references public.clients(id) on delete cascade,
  doc_kind      text not null,
  label         text not null,
  note          text,
  status        text not null default 'requested'
    check (status in ('requested','submitted','approved','rejected')),
  document_id   bigint references public.client_documents(id),
  requested_by  text,
  requested_at  timestamptz not null default now()
);
create index if not exists kyc_requirements_client_idx on public.kyc_requirements (client_id);

alter table public.kyc_requirements enable row level security;
do $$
begin
  create policy "kyc_requirements anon read"   on public.kyc_requirements for select using (true);
  create policy "kyc_requirements anon insert" on public.kyc_requirements for insert with check (true);
  create policy "kyc_requirements anon update" on public.kyc_requirements for update using (true) with check (true);
exception when duplicate_object then null;
end $$;
