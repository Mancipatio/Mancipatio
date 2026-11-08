-- 0088: notification log. One row per notification the platform sends, or
-- decides not to send, so a retried route never sends it twice.
--
-- First user: the conversion emails (lib/server/conversion-notifications.ts):
-- one email to the holder per status change of a conversion request
-- (requested, vault_opened, deposited, converted, cancelled, returned) and
-- one to the operator mailbox (COMPLIANCE_ALERT_EMAIL) for a new request and
-- for a deposit. lib/server/notifications.ts is the generic writer, kept
-- free of conversion details so other features can reuse it.
--
-- At most once: before sending, the server claims the notification's key
-- (network, kind, ref_id, event, recipient_role) with claim_notification(),
-- an insert that does nothing on a conflict; only the call that inserted the
-- row sends. finish_notification() then records the outcome once: sent,
-- failed (with an error class) or skipped (no recipient, email not
-- configured, a reserved test domain). A failed send is not retried, and a
-- row left `pending` (the function stopped between the claim and the
-- outcome) is never retried either: the email may have gone out.
--
-- Privacy: no subject, body, address, wallet or name is stored. ref_id is
-- the conversion request's id (a random uuid); recipient_source says which
-- KIND of address was used (the account's verified email, the verified
-- dossier's email, the request's contact, the configured operator mailbox),
-- never the address; error is a class (^[A-Z_]{1,40}$), never a provider
-- message (SMTP replies can echo addresses).
--
-- Access: RLS on, nothing for anon and authenticated. The service role may
-- only READ the table (operators read it with SQL); every write goes through
-- the two SECURITY DEFINER functions below, which only service_role may
-- execute. A guard trigger keeps the key immutable and lets a row leave
-- `pending` once, to sent, failed or skipped.
--
-- Network: default public.deployment_network(), guarded (0071 rules 1-2).
-- Size: at most eight rows per conversion request; nothing prunes it.
-- Deploy order: either. A front without this migration claims nothing and
-- therefore sends no conversion email (the routes are unaffected).
-- Re-runnable: every statement is idempotent.
begin;
set local lock_timeout = '15s';

do $$
begin
  if to_regprocedure('public.deployment_network()') is null
     or to_regprocedure('mancipatio_ops.install_network_guards()') is null then
    raise exception 'Apply 0070 and 0071 before 0088';
  end if;
end;
$$;

create table if not exists public.notification_log (
  id bigint generated always as identity primary key,
  network text not null default public.deployment_network()
    check (network in ('mainnet', 'devnet', 'testnet', 'localnet')),
  -- What the notification is about: 'conversion' (a conversion_requests row).
  kind text not null check (kind ~ '^[a-z][a-z0-9_]{0,39}$'),
  ref_id text not null check (ref_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  -- The event of that row: 'requested', 'vault_opened', 'deposited', …
  event text not null check (event ~ '^[a-z][a-z0-9_]{0,39}$'),
  recipient_role text not null check (recipient_role in ('holder', 'operator')),
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed', 'skipped')),
  recipient_source text
    check (recipient_source in ('account', 'dossier', 'contact', 'config')),
  error text check (error ~ '^[A-Z_]{1,40}$'),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint notification_log_key unique (network, kind, ref_id, event, recipient_role),
  constraint notification_log_outcome check (
    (status = 'pending' and finished_at is null and error is null)
    or (status = 'sent' and finished_at is not null and error is null and recipient_source is not null)
    or (status in ('failed', 'skipped') and finished_at is not null and error is not null))
);
create index if not exists notification_log_recent_idx
  on public.notification_log (network, created_at desc);
comment on table public.notification_log is
  'One row per notification (0088): claimed before sending (claim_notification), its outcome recorded once (finish_notification). No subject, body or address.';

alter table public.notification_log enable row level security;
-- Supabase's default privileges give every API role everything on a new
-- table: take it back, then let the service role read.
revoke all on public.notification_log from public, anon, authenticated, service_role;
revoke all on sequence public.notification_log_id_seq from public, anon, authenticated, service_role;
grant select on public.notification_log to service_role;

-- The key never changes, and a row leaves `pending` once.
create or replace function public.notification_log_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.network is distinct from old.network or new.kind is distinct from old.kind
     or new.ref_id is distinct from old.ref_id or new.event is distinct from old.event
     or new.recipient_role is distinct from old.recipient_role
     or new.created_at is distinct from old.created_at then
    raise exception 'notification_log key is immutable' using errcode = '23514';
  end if;
  if old.status <> 'pending' then
    raise exception 'notification % is already %', old.id, old.status using errcode = '23514';
  end if;
  if new.status = 'pending' then
    raise exception 'notification % can only leave pending', old.id using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.notification_log_guard() from public, anon, authenticated, service_role;
drop trigger if exists notification_log_guard on public.notification_log;
create trigger notification_log_guard before update on public.notification_log
  for each row execute function public.notification_log_guard();

-- The claim: a new pending row for the key and its id, or null when the key
-- was claimed before (by this call's retry or a concurrent one).
create or replace function public.claim_notification(
  p_kind text,
  p_ref_id text,
  p_event text,
  p_recipient_role text
) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  claimed bigint;
begin
  insert into public.notification_log (kind, ref_id, event, recipient_role)
    values (p_kind, p_ref_id, p_event, p_recipient_role)
    on conflict on constraint notification_log_key do nothing
    returning id into claimed;
  return claimed;
end;
$$;
revoke all on function public.claim_notification(text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_notification(text, text, text, text) to service_role;

-- The outcome of a claimed row of this network: true when it was pending.
create or replace function public.finish_notification(
  p_id bigint,
  p_status text,
  p_error text,
  p_recipient_source text
) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_status is null or p_status not in ('sent', 'failed', 'skipped') then
    raise exception 'Invalid notification outcome' using errcode = '22023';
  end if;
  update public.notification_log
     set status = p_status, error = p_error, recipient_source = p_recipient_source,
         finished_at = pg_catalog.clock_timestamp()
   where id = p_id and network = public.deployment_network() and status = 'pending';
  return found;
end;
$$;
revoke all on function public.finish_notification(bigint, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.finish_notification(bigint, text, text, text) to service_role;

select mancipatio_ops.install_network_guards();

commit;
