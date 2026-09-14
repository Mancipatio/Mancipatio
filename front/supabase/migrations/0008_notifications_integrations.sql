-- 0008_notifications_integrations.sql
-- Broadcast pipeline and per-vendor integration registry.

------------------------------------------------------------------------------
-- notifications — outgoing broadcasts (email / in-app banner / both).
------------------------------------------------------------------------------
create table if not exists public.notifications (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  kind            text not null
    check (kind in ('email', 'in-app', 'both')),
  audience        text not null
    check (audience in (
      'all',
      'issuers',
      'verified-issuers',
      'investors',
      'pending-kyc',
      'tag',
      'wallet'
    )),
  audience_param  text,                   -- tag value or wallet address when relevant

  subject         text not null,
  body            text not null,
  template        text,                   -- optional template slug

  -- Lifecycle.
  status          text not null default 'draft'
    check (status in ('draft', 'scheduled', 'sending', 'sent', 'failed')),
  scheduled_for   timestamptz,
  sent_at         timestamptz,
  recipient_count integer not null default 0,
  provider_ref    text,                   -- resend message id, etc.

  author          text not null,          -- admin wallet
  error           text
);

create index if not exists notifications_status_idx     on public.notifications (status);
create index if not exists notifications_created_at_idx on public.notifications (created_at desc);

create trigger notifications_touch before update on public.notifications
  for each row execute function public.touch_updated_at();

alter table public.notifications enable row level security;

drop policy if exists "notifications anon read"   on public.notifications;
create policy "notifications anon read"
  on public.notifications for select using (true);

drop policy if exists "notifications anon insert" on public.notifications;
create policy "notifications anon insert"
  on public.notifications for insert with check (true);

drop policy if exists "notifications anon update" on public.notifications;
create policy "notifications anon update"
  on public.notifications for update using (true) with check (true);

drop policy if exists "notifications anon delete" on public.notifications;
create policy "notifications anon delete"
  on public.notifications for delete using (true);

------------------------------------------------------------------------------
-- integrations — per-vendor configuration registry.
------------------------------------------------------------------------------
create table if not exists public.integrations (
  slug            text primary key,         -- 'helius' / 'supabase' / 'sumsub' / 'resend' / …
  kind            text not null
    check (kind in (
      'rpc', 'indexer', 'kyc', 'email', 'oracle',
      'onramp', 'multisig', 'monitoring', 'analytics', 'storage', 'other'
    )),
  label           text not null,
  status          text not null default 'not_configured'
    check (status in ('not_configured', 'configured', 'degraded', 'failing', 'disabled')),
  -- Free-form per-vendor config (non-secret bits only — secrets live in
  -- Vercel env / Supabase Vault, this table only points at them).
  config          jsonb not null default '{}'::jsonb,
  notes           text not null default '',
  last_checked_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists integrations_status_idx on public.integrations (status);

create trigger integrations_touch before update on public.integrations
  for each row execute function public.touch_updated_at();

alter table public.integrations enable row level security;

drop policy if exists "integrations anon read"   on public.integrations;
create policy "integrations anon read"
  on public.integrations for select using (true);

drop policy if exists "integrations anon insert" on public.integrations;
create policy "integrations anon insert"
  on public.integrations for insert with check (true);

drop policy if exists "integrations anon update" on public.integrations;
create policy "integrations anon update"
  on public.integrations for update using (true) with check (true);

------------------------------------------------------------------------------
-- Seed: the integrations we expect to see early. Existing rows untouched.
------------------------------------------------------------------------------
insert into public.integrations (slug, kind, label, status, config, notes) values
  ('helius',     'rpc',         'Helius RPC + Webhook',  'configured',     '{"network":"devnet","webhook":true}'::jsonb, 'Indexer Edge Function reachable; webhook auth header in Supabase Vault.'),
  ('supabase',   'indexer',     'Supabase (Postgres + Storage)', 'configured', '{"region":"eu-central-1"}'::jsonb, 'DB + storage + edge functions live.'),
  ('vercel',     'monitoring',  'Vercel (hosting)',      'configured',     '{}'::jsonb, 'mancipatio.io live, CDN healthy.'),
  ('sumsub',     'kyc',         'Sumsub (KYC/KYB)',      'not_configured', '{}'::jsonb, 'Wire up to power the 5 KYC touchpoints.'),
  ('resend',     'email',       'Resend (transactional email)', 'not_configured', '{}'::jsonb, 'Powers /admin/notifications email send and KYC notices.'),
  ('sentry',     'monitoring',  'Sentry (error tracking)', 'not_configured', '{}'::jsonb, 'Frontend + Edge Function error stream.'),
  ('plausible',  'analytics',   'Plausible Analytics',   'not_configured', '{}'::jsonb, 'EU-friendly traffic analytics.'),
  ('pyth',       'oracle',      'Pyth (price oracle)',   'not_configured', '{}'::jsonb, 'USD valuations for /portfolio holdings.'),
  ('moonpay',    'onramp',      'MoonPay (fiat onramp)', 'not_configured', '{}'::jsonb, 'Buy USDC inside /portfolio.'),
  ('squads',     'multisig',    'Squads (multisig)',     'not_configured', '{}'::jsonb, 'Recommended for Super Admin + issuer treasury wallets.'),
  ('helius-das', 'indexer',     'Helius DAS (asset API)', 'not_configured', '{}'::jsonb, 'Optional — richer holdings + metadata view.')
on conflict (slug) do nothing;
