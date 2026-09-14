-- 0001_audit_events.sql
-- Audit log for every privileged admin action.
-- v0.1: open RLS for MVP — anyone with the anon key can insert/read.
-- Phase B+ will move writes behind a Vercel API route + SIWS signature.

create extension if not exists "pgcrypto";

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  -- Solana network this event applies to (devnet / mainnet).
  network text not null default 'devnet',

  -- Privileged instruction name from the asset_registry / transfer_hook program.
  -- Examples: 'set_pause', 'remove_admin', 'lock_supply', 'realize_custody',
  -- 'verify_issuer_kyb', 'cancel_offer', 'finalize_proposal'.
  ix_name text not null,

  -- Free-form category for filtering (platform / admins / share-class / custody / etc).
  category text not null default 'other',

  -- Wallet that signed the transaction.
  actor_wallet text not null,

  -- Optional human-readable label for what was acted on (entity id / PDA).
  target_label text,

  -- Solana tx signature, when known (UI fills it in after send).
  tx_signature text,

  -- Reason captured by the ConfirmModal — required for destructive actions.
  reason text not null,

  -- Outcome: 'success' (signed + on-chain) | 'failed' (RPC/sim error).
  status text not null default 'success'
    check (status in ('success', 'failed', 'pending')),

  -- Optional structured payload (args, error message…).
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists audit_events_created_at_idx
  on public.audit_events (created_at desc);
create index if not exists audit_events_actor_wallet_idx
  on public.audit_events (actor_wallet);
create index if not exists audit_events_ix_name_idx
  on public.audit_events (ix_name);
create index if not exists audit_events_category_idx
  on public.audit_events (category);

-- Row-level security
alter table public.audit_events enable row level security;

-- v0.1 MVP policies: anyone with the anon key can write/read.
-- Anonymity is acceptable on devnet; tighten before mainnet by moving writes
-- behind a server-side endpoint that verifies a SIWS signature.
drop policy if exists "audit_events anon read" on public.audit_events;
create policy "audit_events anon read"
  on public.audit_events for select
  using (true);

drop policy if exists "audit_events anon insert" on public.audit_events;
create policy "audit_events anon insert"
  on public.audit_events for insert
  with check (true);

-- No updates / deletes from the anon key — the log is append-only.
-- (No policies for update / delete → default-deny under RLS.)
