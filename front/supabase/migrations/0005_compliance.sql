-- 0005_compliance.sql
-- AML / sanctions screening alerts. Populated by the daily screening cron
-- (sub-processor TBD) and reviewed by Super Admins in /admin/compliance.

create table if not exists public.compliance_alerts (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  network         text not null default 'devnet',

  -- The subject. Either a Mancipatio client, or a raw wallet that hit a
  -- screening rule before the client row was attached.
  client_id       uuid references public.clients(id) on delete set null,
  wallet          text,

  -- What fired.
  source          text not null,        -- 'manual' / 'ofac' / 'eu' / 'un' / 'tx-pattern' / …
  severity        text not null default 'medium'
    check (severity in ('low', 'medium', 'high', 'critical')),
  confidence      integer not null default 50
    check (confidence between 0 and 100),
  hit_list        text not null default '',  -- e.g. "OFAC SDN; EU CFSP"
  evidence        jsonb not null default '{}'::jsonb,
  summary         text not null default '',

  -- Review state.
  status          text not null default 'open'
    check (status in ('open', 'dismissed', 'escalated', 'resolved')),
  resolution_note text,
  resolved_by     text,
  resolved_at     timestamptz,

  -- Optional pointer to the on-chain tx that triggered the alert (if any).
  tx_signature    text
);

create index if not exists compliance_alerts_status_idx     on public.compliance_alerts (network, status);
create index if not exists compliance_alerts_client_idx     on public.compliance_alerts (client_id);
create index if not exists compliance_alerts_wallet_idx     on public.compliance_alerts (wallet);
create index if not exists compliance_alerts_severity_idx   on public.compliance_alerts (severity);
create index if not exists compliance_alerts_created_at_idx on public.compliance_alerts (created_at desc);

create trigger compliance_alerts_touch before update on public.compliance_alerts
  for each row execute function public.touch_updated_at();

alter table public.compliance_alerts enable row level security;

drop policy if exists "compliance_alerts anon read"   on public.compliance_alerts;
create policy "compliance_alerts anon read"
  on public.compliance_alerts for select using (true);

drop policy if exists "compliance_alerts anon insert" on public.compliance_alerts;
create policy "compliance_alerts anon insert"
  on public.compliance_alerts for insert with check (true);

drop policy if exists "compliance_alerts anon update" on public.compliance_alerts;
create policy "compliance_alerts anon update"
  on public.compliance_alerts for update using (true) with check (true);
