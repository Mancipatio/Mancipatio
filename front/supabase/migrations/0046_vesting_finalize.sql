-- Stable creation intents bind every retry to the reviewed terms and the same
-- series PDA. Existing rights tokens and on-chain accounts are not migrated.
-- Old approved rows have no hash and must be explicitly re-reviewed.
alter table public.vesting_series alter column series_id type text using series_id::text;
alter table public.vesting_series
  add column if not exists approved_terms_hash text,
  add column if not exists creation_terms_hash text,
  add column if not exists creation_prepared_at timestamptz;
create unique index if not exists vesting_series_chain_address_unique
  on public.vesting_series(network, series_pda) where series_pda is not null;

create table if not exists public.vesting_creation_steps (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.vesting_series(id),
  network text not null,
  step_key text not null check(step_key ~ '^(create|finalize|positions:[0-9]+:[0-9]+)$'),
  signature text not null,
  state text not null default 'submitted' check(state in ('submitted','verified','failed')),
  slot text,
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  unique(network, signature)
);
alter table public.vesting_creation_steps enable row level security;
revoke all on public.vesting_creation_steps from anon, authenticated;
grant all on public.vesting_creation_steps to service_role;
create index if not exists vesting_creation_steps_request on public.vesting_creation_steps(request_id);

create or replace function public.vesting_series_guard_status()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status is distinct from old.status and not (
    (old.status = 'submitted' and new.status in ('needs_changes','approved','rejected')) or
    (old.status = 'needs_changes' and new.status = 'submitted') or
    (old.status = 'approved' and new.status in ('created','cancelled')) or
    -- Legacy approvals require a fresh review under the current transaction limit.
    (old.status = 'approved' and new.status = 'needs_changes' and old.approved_terms_hash is null and old.series_pda is null) or
    (old.status = 'created' and new.status = 'cancelled')
  ) then raise exception 'illegal vesting series status transition: % -> %',old.status,new.status; end if;
  if old.status in ('approved','created','cancelled','rejected') and (
    row(new.network,new.client_wallet,new.token_mint,new.token_label,new.timing_mode,new.delivery_mode,
        new.approval_window_secs,new.recovery_enabled,new.cancellation_enabled,new.pre_cliff_bps,new.schedule,new.recipients)
    is distinct from
    row(old.network,old.client_wallet,old.token_mint,old.token_label,old.timing_mode,old.delivery_mode,
        old.approval_window_secs,old.recovery_enabled,old.cancellation_enabled,old.pre_cliff_bps,old.schedule,old.recipients)
  ) then raise exception 'reviewed vesting terms are locked'; end if;
  if old.approved_terms_hash is not null and new.approved_terms_hash is distinct from old.approved_terms_hash then
    raise exception 'approved vesting hash is immutable';
  end if;
  if new.status = 'approved' and old.status <> 'approved' and coalesce(new.approved_terms_hash,'') !~ '^[0-9a-f]{64}$' then
    raise exception 'approval requires a canonical terms hash';
  end if;
  if old.creation_prepared_at is not null and
    row(new.series_id,new.series_pda,new.escrow,new.creation_terms_hash,new.creation_prepared_at)
      is distinct from row(old.series_id,old.series_pda,old.escrow,old.creation_terms_hash,old.creation_prepared_at) then
    raise exception 'prepared vesting intent is immutable';
  end if;
  if new.creation_prepared_at is not null and (
    new.series_id is null or new.series_id !~ '^[0-9]+$' or new.series_pda is null or new.escrow is null
    or new.creation_terms_hash is null or new.creation_terms_hash is distinct from new.approved_terms_hash
  ) then raise exception 'creation intent must match approved terms'; end if;
  if new.status = 'created' and old.status <> 'created' and (new.creation_prepared_at is null or new.created_tx is null) then
    raise exception 'creation requires a prepared intent and verified finalization receipt';
  end if;
  return new;
end;
$$;
