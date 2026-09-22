-- Accounts that exist without a wallet: sign in with an email link or Google,
-- add wallets later. Verification (the KYC/KYB dossier) belongs to the account.
--
-- New authority path ("account actor"): an HMAC session cookie carries the
-- account id; the *_by_id functions below act on that id directly. The
-- wallet actor path (SIWS, lock_account_for_wallet) is unchanged.
begin;

-- 1. Profiles may have no wallet; one account per verified email / Google id.
alter table public.account_profiles alter column wallet drop not null;
alter table public.account_profiles alter column primary_wallet drop not null;
create unique index account_profiles_email_unique on public.account_profiles(network, email) where email is not null;
create unique index account_profiles_google_unique on public.account_profiles(network, google_sub) where google_sub is not null;
alter table public.account_email_requests alter column wallet drop not null;

-- 2. Email sign-in links (hash only) and Google sign-in states.
create table public.auth_login_tokens (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  network text not null,
  email text not null check (length(email) between 3 and 254),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '30 minutes')
);
create index auth_login_tokens_email_time on public.auth_login_tokens(email, created_at);
create table public.auth_google_states (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  browser_hash text not null check (browser_hash ~ '^[0-9a-f]{64}$'),
  network text not null,
  code_verifier text not null,
  redirect_uri text not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null
);
create index auth_google_states_expiry on public.auth_google_states(expires_at);

-- 3. The verification dossier belongs to the account.
alter table public.clients add column account_id uuid references public.account_profiles(id) on delete set null;
create unique index clients_account_unique on public.clients(account_id) where account_id is not null;
update public.clients c set account_id = w.account_id
  from public.account_wallets w where w.wallet = c.wallet and w.network = c.network and c.account_id is null;

alter table public.auth_login_tokens enable row level security;
alter table public.auth_google_states enable row level security;
revoke all on public.auth_login_tokens, public.auth_google_states from public, anon, authenticated;
grant all on public.auth_login_tokens, public.auth_google_states to service_role;

-- 4. Account-id functions ------------------------------------------------------
create function public.lock_account_by_id(p_account_id uuid, p_network text) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.account_profiles where id = p_account_id and network = p_network for update;
  if not found then return null; end if;
  return p_account_id;
end $$;

create function public.get_account_profile(p_account_id uuid, p_network text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'wallet', null, 'network', p.network, 'primary_wallet', p.primary_wallet,
    'wallets', (select coalesce(jsonb_agg(jsonb_build_object('wallet', w.wallet, 'linked_at', w.linked_at) order by w.linked_at, w.wallet), '[]'::jsonb)
      from public.account_wallets w where w.account_id = p.id and w.network = p.network),
    'display_name', p.display_name, 'email', p.email, 'email_verified_at', p.email_verified_at,
    'pending_email', p.pending_email, 'pending_email_expires_at', p.pending_email_expires_at,
    'google_email', p.google_email, 'google_linked_at', p.google_linked_at,
    'created_at', p.created_at, 'updated_at', p.updated_at)
  from public.account_profiles p where p.id = p_account_id and p.network = p_network
$$;

-- Sign in with a verified email: the existing account, or a new wallet-less one.
create function public.login_account_email(p_network text, p_email text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare owner_id uuid; e text := lower(btrim(p_email));
begin
  if e !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' or length(e) > 254 then raise exception 'Invalid email'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-login:' || p_network || ':' || e, 0));
  select id into owner_id from public.account_profiles where network = p_network and email = e;
  if owner_id is null then
    insert into public.account_profiles(network, email, email_verified_at) values (p_network, e, clock_timestamp())
      returning id into owner_id;
  end if;
  return owner_id;
end $$;

-- Sign in with Google: by Google id, else attach to the account with the same
-- verified email, else create a wallet-less account.
create function public.login_account_google(p_network text, p_sub text, p_email text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare owner_id uuid; e text := lower(btrim(p_email));
begin
  if p_sub is null or length(p_sub) not between 1 and 255 or length(e) not between 3 and 254 then raise exception 'Invalid Google identity'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-login:' || p_network || ':' || e, 0));
  select id into owner_id from public.account_profiles where network = p_network and google_sub = p_sub;
  if owner_id is not null then return owner_id; end if;
  select id into owner_id from public.account_profiles where network = p_network and email = e for update;
  if owner_id is not null then
    update public.account_profiles set google_sub = p_sub, google_email = e, google_linked_at = clock_timestamp() where id = owner_id;
    return owner_id;
  end if;
  insert into public.account_profiles(network, email, email_verified_at, google_sub, google_email, google_linked_at)
    values (p_network, e, clock_timestamp(), p_sub, e, clock_timestamp()) returning id into owner_id;
  return owner_id;
end $$;

-- Consume an email sign-in link exactly once.
create function public.consume_login_token(p_token_hash text, p_network text) returns text
language plpgsql security definer set search_path = '' as $$
declare e text;
begin
  update public.auth_login_tokens set consumed_at = clock_timestamp()
    where token_hash = p_token_hash and network = p_network and consumed_at is null and expires_at > clock_timestamp()
    returning email into e;
  return e;
end $$;

-- Add a wallet to an account (the wallet signed, the account session is live).
-- Same safety rule as wallet-to-wallet linking: only an untouched automatic
-- singleton account of that wallet may be discarded; nothing is ever merged.
create function public.attach_account_wallet(p_account_id uuid, p_network text, p_wallet text) returns text
language plpgsql security definer set search_path = '' as $$
declare target_account uuid;
begin
  if p_wallet !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' then return 'invalid'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-wallet:' || p_network || ':' || p_wallet, 0));
  select account_id into target_account from public.account_wallets where network = p_network and wallet = p_wallet;
  perform 1 from public.account_profiles where network = p_network and id in (p_account_id, target_account) order by id for update;
  if not exists (select 1 from public.account_profiles where id = p_account_id and network = p_network) then return 'invalid'; end if;
  if target_account = p_account_id then return 'same_wallet'; end if;
  if (select count(*) from public.account_wallets where account_id = p_account_id) >= 10 then return 'wallet_limit'; end if;
  if target_account is not null then
    if (select count(*) from public.account_wallets where account_id = target_account) <> 1
      or not exists (select 1 from public.account_profiles where id = target_account and display_name = ''
        and email is null and pending_email is null and google_sub is null and primary_wallet = p_wallet)
      or exists (select 1 from public.account_email_requests where account_id = target_account)
      or exists (select 1 from public.account_google_states where account_id = target_account)
      or exists (select 1 from public.account_wallet_links where account_id = target_account)
      or exists (select 1 from public.clients where account_id = target_account) then return 'account_conflict'; end if;
    delete from public.account_wallets where account_id = target_account;
    delete from public.account_profiles where id = target_account;
  end if;
  insert into public.account_wallets(network, wallet, account_id) values (p_network, p_wallet, p_account_id);
  update public.account_profiles set primary_wallet = coalesce(primary_wallet, p_wallet), updated_at = clock_timestamp()
    where id = p_account_id;
  return 'linked';
end $$;

-- Mutations for the account actor (mirrors mutate_account_profile).
create function public.mutate_account_by_id(p_account_id uuid, p_network text, p_action text, p_params jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare allowed text[]; owner_id uuid; result jsonb; now_at timestamptz := clock_timestamp(); changed int; e text; target text;
begin
  if p_params is null or jsonb_typeof(p_params) <> 'object' or p_action is null then raise exception 'Invalid account mutation'; end if;
  case p_action
    when 'update' then allowed := array['display_name'];
    when 'email.request' then allowed := array['email','token_hash','recipient_hash'];
    when 'email.cancel' then allowed := array['token_hash'];
    when 'email.verify' then allowed := array['token_hash'];
    when 'google.unlink' then allowed := array[]::text[];
    when 'wallets.primary' then allowed := array['wallet'];
    when 'wallets.remove' then allowed := array['wallet'];
    else raise exception 'Invalid account mutation';
  end case;
  if not (p_params ?& allowed) or exists (select 1 from jsonb_object_keys(p_params) k where not (k = any(allowed))) then
    raise exception 'Invalid account mutation fields';
  end if;
  if p_action = 'email.request' then
    e := p_params->>'email';
    if e is null or length(e) not between 3 and 254 or e <> lower(btrim(e)) or e !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
      or (p_params->>'token_hash') !~ '^[0-9a-f]{64}$'
      or p_params->>'recipient_hash' is distinct from encode(sha256(convert_to(e, 'UTF8')), 'hex') then raise exception 'Invalid verification request'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-email:' || (p_params->>'recipient_hash'), 0));
  end if;
  owner_id := public.lock_account_by_id(p_account_id, p_network);
  if owner_id is null then return jsonb_build_object('ok', false); end if;
  case p_action
    when 'update' then
      if length(p_params->>'display_name') > 100 or (p_params->>'display_name') ~ '[[:cntrl:]]' then result := to_jsonb(false);
      else update public.account_profiles set display_name = p_params->>'display_name' where id = owner_id; result := to_jsonb(true); end if;
    when 'email.request' then
      if exists (select 1 from public.account_email_requests where account_id = owner_id and created_at > now_at - interval '60 seconds')
        or (select count(*) from public.account_email_requests where account_id = owner_id and created_at > now_at - interval '1 hour') >= 5
        or (select count(*) from public.account_email_requests where recipient_hash = p_params->>'recipient_hash' and created_at > now_at - interval '1 hour') >= 10 then
        result := to_jsonb('rate_limited'::text);
      else
        insert into public.account_email_requests(token_hash, network, wallet, account_id, recipient_hash, created_at)
          values (p_params->>'token_hash', p_network, null, owner_id, p_params->>'recipient_hash', now_at);
        update public.account_profiles set pending_email = e, pending_email_token_hash = p_params->>'token_hash',
          pending_email_requested_by = null, pending_email_expires_at = now_at + interval '30 minutes' where id = owner_id;
        result := to_jsonb('requested'::text);
      end if;
    when 'email.cancel' then
      update public.account_profiles set pending_email = null, pending_email_token_hash = null, pending_email_expires_at = null, pending_email_requested_by = null
        where id = owner_id and pending_email_token_hash is not null and (p_params->'token_hash' = 'null'::jsonb or pending_email_token_hash = p_params->>'token_hash');
      get diagnostics changed = row_count; result := to_jsonb(changed = 1);
    when 'email.verify' then
      begin
        update public.account_profiles set email = pending_email, email_verified_at = clock_timestamp(),
          pending_email = null, pending_email_token_hash = null, pending_email_expires_at = null, pending_email_requested_by = null
          where id = owner_id and pending_email_token_hash = p_params->>'token_hash' and pending_email_expires_at > clock_timestamp();
        get diagnostics changed = row_count; result := to_jsonb(changed = 1);
      exception when unique_violation then result := to_jsonb(false);
      end;
    when 'google.unlink' then
      delete from public.account_google_states where account_id = owner_id;
      update public.account_profiles set google_sub = null, google_email = null, google_linked_at = null where id = owner_id;
      result := to_jsonb(true);
    when 'wallets.primary' then
      target := p_params->>'wallet';
      if not exists (select 1 from public.account_wallets where account_id = owner_id and network = p_network and wallet = target) then result := to_jsonb('not_member'::text);
      else update public.account_profiles set primary_wallet = target where id = owner_id; result := to_jsonb('updated'::text); end if;
    when 'wallets.remove' then
      target := p_params->>'wallet';
      if not exists (select 1 from public.account_wallets where account_id = owner_id and network = p_network and wallet = target) then result := to_jsonb('not_member'::text);
      elsif exists (select 1 from public.account_profiles where id = owner_id and primary_wallet = target)
        and (select count(*) from public.account_wallets where account_id = owner_id) > 1 then result := to_jsonb('primary'::text);
      else
        delete from public.account_wallet_links where account_id = owner_id and network = p_network and target_wallet = target;
        delete from public.account_wallets where account_id = owner_id and network = p_network and wallet = target;
        -- The account stays reachable by email/Google even with no wallet left.
        update public.account_profiles set primary_wallet = case when primary_wallet = target then null else primary_wallet end,
          updated_at = clock_timestamp() where id = owner_id;
        result := to_jsonb('removed'::text);
      end if;
  end case;
  return jsonb_build_object('ok', true, 'result', result);
end $$;

-- A wallet-less email request (requested_by null) may be confirmed from any
-- wallet of the same account, as before for wallet requests.
create or replace function public.verify_account_email(p_wallet text, p_network text, p_token_hash text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare owner_id uuid; changed integer;
begin
  owner_id := public.lock_account_for_wallet(p_wallet, p_network);
  if owner_id is null then return false; end if;
  begin
    update public.account_profiles p set email = pending_email, email_verified_at = clock_timestamp(),
      pending_email = null, pending_email_token_hash = null, pending_email_expires_at = null, pending_email_requested_by = null
      where id = owner_id and pending_email_token_hash = p_token_hash and pending_email_expires_at > clock_timestamp()
        and (p.pending_email_requested_by is null or exists (select 1 from public.account_wallets w
          where w.account_id = owner_id and w.network = p_network and w.wallet = p.pending_email_requested_by));
    get diagnostics changed = row_count;
  exception when unique_violation then return false;
  end;
  return changed = 1;
end $$;

revoke all on function public.lock_account_by_id(uuid,text), public.get_account_profile(uuid,text),
  public.login_account_email(text,text), public.login_account_google(text,text,text), public.consume_login_token(text,text),
  public.attach_account_wallet(uuid,text,text), public.mutate_account_by_id(uuid,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.lock_account_by_id(uuid,text), public.get_account_profile(uuid,text),
  public.login_account_email(text,text), public.login_account_google(text,text,text), public.consume_login_token(text,text),
  public.attach_account_wallet(uuid,text,text), public.mutate_account_by_id(uuid,text,text,jsonb) to service_role;

commit;
