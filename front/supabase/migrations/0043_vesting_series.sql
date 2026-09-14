-- 0043: Vesting series — client self-serve vesting requests + review workflow
-- (spec: "11. Vesting — Mancipatio").
--
-- Flow: the CLIENT (KYC-verified) fills the series form (token, recipients,
-- schedule, timing/delivery mode, approval window, recovery, cancellation,
-- pre-cliff %) and submits it → the team reviews (approve / send back to fix /
-- reject) → the approved client creates the on-chain VestingSeries from the
-- issuer console (their own wallet is the series authority — Mancipatio holds
-- no key) → deposits → positions vest by schedule. This table is the
-- off-chain intake + mirror; the on-chain program is authoritative for
-- escrow/release accounting.
--
-- PRIVACY / RLS: NO anon policies at all (default-deny, same stance as
-- conversion_requests in 0034). Rows carry recipient wallet lists, so every
-- read and write goes through signed service-role routes:
--   reads:  /api/vesting-series/list-mine  (signed; caller's own rows)
--           /api/vesting-series/admin-list (signed + on-chain admin gate)
--   writes: /api/vesting-series/create | /update | /mark-created |
--           /mark-cancelled (signed, owner-bound) and
--           /api/vesting-series/admin-review (signed + admin gate).

create table if not exists public.vesting_series (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  network text not null default 'devnet',
  -- The client (series authority on-chain).
  client_wallet text not null,
  client_id uuid references public.clients(id) on delete set null,
  -- Form payload (spec §11.1.2).
  token_mint text not null,
  token_label text not null default '',
  timing_mode text not null check (timing_mode in ('auto', 'approval')),
  delivery_mode text not null check (delivery_mode in ('push', 'claim')),
  approval_window_secs integer not null default 0,
  recovery_enabled boolean not null default false,
  cancellation_enabled boolean not null default false,
  pre_cliff_bps integer not null default 0,
  -- [{ "unlock_ts": number, "amount": string }] — amounts as strings (u64).
  schedule jsonb not null default '[]'::jsonb,
  -- [{ "wallet": string, "allocation": string }] — allocations as strings.
  recipients jsonb not null default '[]'::jsonb,
  -- Review workflow.
  status text not null default 'submitted' check (status in (
    'submitted', 'needs_changes', 'approved', 'rejected', 'created', 'cancelled'
  )),
  review_reason text,
  reviewed_by text,
  reviewed_at timestamptz,
  -- On-chain mirror (stamped after the client creates the series on-chain).
  series_id numeric(20, 0),
  series_pda text,
  escrow text,
  created_tx text,
  cancelled_tx text
);

drop trigger if exists vesting_series_touch on public.vesting_series;
create trigger vesting_series_touch before update on public.vesting_series
  for each row execute function public.touch_updated_at();

create index if not exists vesting_series_wallet_idx on public.vesting_series(client_wallet);
create index if not exists vesting_series_status_idx on public.vesting_series(status);
create index if not exists vesting_series_network_idx on public.vesting_series(network);

-- Audit trail for the review workflow (mirrors application_events, 0017).
create table if not exists public.vesting_series_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  series_id uuid not null references public.vesting_series(id) on delete cascade,
  actor text not null check (actor in ('client', 'admin')),
  action text not null check (action in (
    'submitted', 'resubmitted', 'approved', 'needs_changes', 'rejected',
    'created_onchain', 'cancelled_onchain'
  )),
  reason text,
  actor_wallet text not null default ''
);

create index if not exists vesting_series_events_series_idx
  on public.vesting_series_events(series_id);

-- ---------------------------------------------------------------------------
-- Status-transition guard (0030/0034 style — defense in depth).
--
--   submitted     -> needs_changes | approved | rejected   (team review)
--   needs_changes -> submitted                              (client resubmits)
--   approved      -> created                                (client creates on-chain)
--   created       -> cancelled                              (client cancels on-chain)
--   rejected / cancelled : terminal
-- ---------------------------------------------------------------------------

create or replace function public.vesting_series_guard_status()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    if not (
      (old.status = 'submitted'     and new.status in ('needs_changes', 'approved', 'rejected')) or
      (old.status = 'needs_changes' and new.status = 'submitted') or
      (old.status = 'approved'      and new.status = 'created') or
      (old.status = 'created'       and new.status = 'cancelled')
    ) then
      raise exception 'illegal vesting series status transition: % -> %', old.status, new.status;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists vesting_series_status_guard on public.vesting_series;
create trigger vesting_series_status_guard
  before update on public.vesting_series
  for each row execute function public.vesting_series_guard_status();

-- ---------------------------------------------------------------------------
-- RLS: enable and deliberately create NO policies — default-deny for anon and
-- authenticated. Recipient wallet lists are counterparty PII; every read and
-- write goes through the signed service-role routes listed in the header
-- (service role bypasses RLS).
-- ---------------------------------------------------------------------------

alter table public.vesting_series enable row level security;
alter table public.vesting_series_events enable row level security;
