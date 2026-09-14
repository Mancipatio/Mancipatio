-- 0044 — durable SIWS v2 nonces, atomic invitation identity binding and private
-- profile/OTC/audit/legacy-beneficiary reads.
--
-- ROLLOUT: use a short maintenance window. Apply 0041 and all earlier migrations,
-- then this migration, then deploy the matching SIWS v2 + signed-reader front.
-- Old front requests are intentionally rejected by v2. Applying this RLS change
-- while serving the old direct-reader front hides its private screens; deploying
-- the v2 front before this migration fails all signed requests closed with 503.
-- Verify NEXT_PUBLIC_SITE_URL is the canonical HTTPS origin before reopening.
-- Public marketplace profiles are explicit allowlisted API projections; no anon
-- base-table policy is needed. Never roll back by re-enabling blanket SELECT.

begin;

create table if not exists public.siws_nonces (
  origin text not null check (length(origin) between 1 and 255),
  network text not null check (network in ('devnet', 'mainnet', 'testnet', 'localnet')),
  wallet text not null check (length(wallet) between 32 and 44),
  nonce uuid not null,
  expires_at timestamptz not null,
  consumed_at timestamptz not null default clock_timestamp(),
  primary key (origin, network, wallet, nonce)
);
create index if not exists siws_nonces_expiry_idx on public.siws_nonces (expires_at);
alter table public.siws_nonces enable row level security;
revoke all on public.siws_nonces from public, anon, authenticated;
grant all on public.siws_nonces to service_role;

-- Insert ON CONFLICT is the cross-worker/restart replay boundary. Cleanup only
-- removes entries after their signed validity has ended, in bounded batches.
create or replace function public.consume_siws_nonce(
  p_origin text, p_network text, p_wallet text, p_nonce uuid,
  p_expires_at timestamptz
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  inserted_count integer;
begin
  if p_expires_at <= clock_timestamp()
     or p_expires_at > clock_timestamp() + interval '11 minutes' then
    return false;
  end if;
  delete from public.siws_nonces
   where ctid in (
     select ctid from public.siws_nonces
      where expires_at < clock_timestamp() - interval '1 minute'
      order by expires_at, origin, network, wallet, nonce limit 1000
   );
  insert into public.siws_nonces (origin, network, wallet, nonce, expires_at)
  values (p_origin, p_network, p_wallet, p_nonce, p_expires_at)
  on conflict (origin, network, wallet, nonce) do nothing;
  get diagnostics inserted_count = row_count;
  return inserted_count = 1;
end;
$$;
revoke all on function public.consume_siws_nonce(text, text, text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.consume_siws_nonce(text, text, text, uuid, timestamptz)
  to service_role;

-- 0041 could skip this index when legacy duplicates existed. Do not silently
-- ship a weaker identity boundary; operator-approved merges must precede retry.
-- Preserve the existing global-wallet uniqueness contract in this migration.
do $$
begin
  if exists (
    select 1 from public.clients where wallet is not null
      group by wallet having count(*) > 1
  ) then
    raise exception '0044: duplicate linked client wallets must be resolved before applying identity protection';
  end if;
end;
$$;
create unique index if not exists clients_wallet_unique
  on public.clients (wallet) where wallet is not null;

-- The route already verifies SIWS and SHA256(token). This function is callable
-- by service_role only. Token expiry/rotation, network, wallet and terminal KYC
-- are rechecked inside the same transaction as the identity update and note.
create or replace function public.link_client_wallet(
  p_client_id uuid, p_token text, p_wallet text, p_network text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  client_row public.clients%rowtype;
  token_expiry timestamptz;
begin
  if p_token is null or length(p_token) not between 1 and 128
     or p_wallet is null or p_wallet !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     or p_network not in ('devnet', 'mainnet', 'testnet', 'localnet') then
    return jsonb_build_object('status', 'invalid_invitation');
  end if;
  -- Serializes competing invitations for one wallet before taking a dossier
  -- row lock. The unique index also covers concurrent non-invitation writers.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('mancipatio:client-wallet:' || p_wallet, 0)
  );
  select * into client_row from public.clients
   where id = p_client_id and network = p_network and onboarding_token = p_token
   for update;
  if not found then
    return jsonb_build_object('status', 'invalid_invitation');
  end if;
  token_expiry := coalesce(client_row.onboarding_token_expires_at,
                           client_row.created_at + interval '14 days');
  if token_expiry is null or token_expiry <= clock_timestamp() then
    return jsonb_build_object('status', 'expired');
  end if;
  if client_row.wallet is not null and client_row.wallet <> p_wallet then
    return jsonb_build_object('status', 'wallet_conflict');
  end if;
  if client_row.kyc_status in ('suspended', 'rejected') or exists (
    select 1 from public.clients
     where wallet = p_wallet and kyc_status in ('suspended', 'rejected')
  ) then
    return jsonb_build_object('status', 'terminal_kyc');
  end if;
  if exists (
    select 1 from public.clients where wallet = p_wallet and id <> p_client_id
  ) then
    return jsonb_build_object('status', 'wallet_in_use');
  end if;
  if client_row.wallet = p_wallet then
    -- A newly signed retry is semantically idempotent: no status regression,
    -- duplicate note or extension of the invitation's remaining lifetime.
    return jsonb_build_object('status', 'linked', 'already_linked', true);
  end if;
  update public.clients
     set wallet = p_wallet,
         onboarding_status = 'connected',
         onboarding_token_expires_at = least(token_expiry, clock_timestamp() + interval '7 days'),
         last_activity_at = clock_timestamp()
   where id = p_client_id and network = p_network and wallet is null;
  insert into public.client_notes (client_id, author, body, kind)
  values (p_client_id, p_wallet, 'Wallet ownership verified and linked through the invitation.', 'system');
  update public.clients
     set notes_count = (select count(*) from public.client_notes where client_id = p_client_id)
   where id = p_client_id;
  return jsonb_build_object('status', 'linked', 'already_linked', false);
end;
$$;
revoke all on function public.link_client_wallet(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.link_client_wallet(uuid, text, text, text)
  to service_role;

-- Remove every historical policy, including differently named policies and
-- ALL policies, so a forgotten permissive policy cannot retain an anon path.
do $$
declare pol record; tbl text;
begin
  for pol in
    select policyname, tablename from pg_policies
    where schemaname = 'public' and tablename in (
      'otc_requests', 'audit_events', 'asset_profiles', 'issuer_profiles',
      'vesting_beneficiaries'
    )
  loop
    execute format('drop policy %I on public.%I', pol.policyname, pol.tablename);
  end loop;
  foreach tbl in array array[
    'otc_requests', 'audit_events', 'asset_profiles', 'issuer_profiles',
    'vesting_beneficiaries'
  ] loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('revoke select on public.%I from anon, authenticated', tbl);
    execute format('grant select on public.%I to service_role', tbl);
  end loop;
end;
$$;

commit;
