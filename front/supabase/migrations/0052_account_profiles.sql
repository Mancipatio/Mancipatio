-- Private wallet contact preferences. These records never grant KYC or roles.
-- Apply before enabling the account API. No existing clients/CRM rows change.
begin;

create table public.account_profiles (
  network text not null check (network in ('devnet','mainnet','testnet','localnet')),
  wallet text not null check (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  display_name text not null default '' check (length(display_name) <= 100),
  email text check (length(email) between 3 and 254),
  email_verified_at timestamptz,
  pending_email text check (length(pending_email) between 3 and 254),
  pending_email_token_hash text check (pending_email_token_hash ~ '^[0-9a-f]{64}$'),
  pending_email_expires_at timestamptz,
  google_sub text check (length(google_sub) between 1 and 255),
  google_email text check (length(google_email) between 3 and 254),
  google_linked_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (network,wallet),
  check ((email is null) = (email_verified_at is null)),
  check ((pending_email is null) = (pending_email_token_hash is null)
     and (pending_email is null) = (pending_email_expires_at is null)),
  check ((google_sub is null) = (google_email is null)
     and (google_sub is null) = (google_linked_at is null))
);
create trigger account_profiles_touch before update on public.account_profiles
  for each row execute function public.touch_updated_at();

-- Retain only hashes for delivery limits; never retain raw verification tokens.
create table public.account_email_requests (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  network text not null,
  wallet text not null,
  recipient_hash text not null check (recipient_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (network,wallet) references public.account_profiles(network,wallet) on delete cascade
);
create index account_email_wallet_time on public.account_email_requests(network,wallet,created_at);
create index account_email_recipient_time on public.account_email_requests(recipient_hash,created_at);
create index account_email_request_time on public.account_email_requests(created_at);

create table public.account_rate_limits (
  key_hash text primary key check (key_hash ~ '^[0-9a-f]{64}$'),
  hits timestamptz[] not null default '{}',
  updated_at timestamptz not null default clock_timestamp()
);
create index account_rate_limit_time on public.account_rate_limits(updated_at);

create table public.account_google_states (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  wallet text not null,
  network text not null,
  browser_hash text not null check (browser_hash ~ '^[0-9a-f]{64}$'),
  code_verifier text not null check (code_verifier ~ '^[A-Za-z0-9._~-]{43,128}$'),
  redirect_uri text not null check (length(redirect_uri) between 1 and 2048),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (network,wallet) references public.account_profiles(network,wallet) on delete cascade,
  check (expires_at > created_at and expires_at <= created_at + interval '15 minutes')
);
create index account_google_owner on public.account_google_states(network,wallet);
create index account_google_expiry on public.account_google_states(expires_at);

alter table public.account_profiles enable row level security;
alter table public.account_email_requests enable row level security;
alter table public.account_rate_limits enable row level security;
alter table public.account_google_states enable row level security;
revoke all on public.account_profiles, public.account_email_requests,
  public.account_rate_limits, public.account_google_states from public,anon,authenticated;
grant all on public.account_profiles, public.account_email_requests,
  public.account_rate_limits, public.account_google_states to service_role;

create function public.consume_account_rate_limit(p_key_hash text,p_limit integer,p_window_seconds integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare recent timestamptz[]; now_at timestamptz := clock_timestamp();
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' or p_limit is null
    or p_limit not between 1 and 100 or p_window_seconds is null
    or p_window_seconds not between 1 and 86400 then
    raise exception 'Invalid rate limit';
  end if;
  insert into public.account_rate_limits(key_hash) values(p_key_hash) on conflict do nothing;
  select hits into recent from public.account_rate_limits where key_hash=p_key_hash for update;
  select coalesce(array_agg(hit),'{}') into recent from unnest(recent) as hit
    where hit > now_at - make_interval(secs => p_window_seconds);
  if cardinality(recent) >= p_limit then return false; end if;
  update public.account_rate_limits set hits=array_append(recent,now_at),updated_at=now_at where key_hash=p_key_hash;
  delete from public.account_rate_limits where key_hash in (
    select key_hash from public.account_rate_limits where updated_at < now_at - interval '1 day'
      order by updated_at limit 100 for update skip locked
  );
  return true;
end;
$$;

create function public.request_account_email_verification(
  p_wallet text,p_network text,p_email text,p_token_hash text,p_recipient_hash text
) returns text language plpgsql security definer set search_path = '' as $$
declare now_at timestamptz := clock_timestamp();
begin
  if p_email is null or length(p_email) not between 3 and 254 or p_email <> lower(btrim(p_email))
     or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
     or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
     or p_recipient_hash is null or p_recipient_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid verification request';
  end if;
  -- Serialize recipient limits across many wallets, then serialize this wallet.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-email:' || p_recipient_hash,0));
  insert into public.account_profiles(network,wallet) values(p_network,p_wallet) on conflict do nothing;
  perform 1 from public.account_profiles where network=p_network and wallet=p_wallet for update;
  if exists(select 1 from public.account_email_requests where network=p_network and wallet=p_wallet
       and created_at > now_at - interval '60 seconds')
     or (select count(*) from public.account_email_requests where network=p_network and wallet=p_wallet
       and created_at > now_at - interval '1 hour') >= 5
     or (select count(*) from public.account_email_requests where recipient_hash=p_recipient_hash
       and created_at > now_at - interval '1 hour') >= 10 then
    return 'rate_limited';
  end if;
  insert into public.account_email_requests(token_hash,network,wallet,recipient_hash,created_at)
    values(p_token_hash,p_network,p_wallet,p_recipient_hash,now_at);
  update public.account_profiles set pending_email=p_email,pending_email_token_hash=p_token_hash,
    pending_email_expires_at=now_at + interval '30 minutes' where network=p_network and wallet=p_wallet;
  delete from public.account_email_requests where token_hash in (
    select token_hash from public.account_email_requests where created_at < now_at - interval '1 day'
      order by created_at limit 100 for update skip locked
  );
  return 'requested';
end;
$$;

create function public.verify_account_email(p_wallet text,p_network text,p_token_hash text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare changed integer;
begin
  -- UPDATE takes the row lock and rechecks the predicates after a concurrent
  -- update: only one request consumes the token, and old challenges cannot win.
  update public.account_profiles set email=pending_email,email_verified_at=clock_timestamp(),
    pending_email=null,pending_email_token_hash=null,pending_email_expires_at=null
    where network=p_network and wallet=p_wallet and pending_email_token_hash=p_token_hash
      and pending_email_expires_at > clock_timestamp();
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

create function public.cancel_account_email_verification(p_wallet text,p_network text,p_token_hash text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare changed integer;
begin
  update public.account_profiles set pending_email=null,pending_email_token_hash=null,pending_email_expires_at=null
    where network=p_network and wallet=p_wallet and pending_email_token_hash is not null
      and (p_token_hash is null or pending_email_token_hash=p_token_hash);
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

create function public.complete_account_google_link(
  p_state_hash text,p_browser_hash text,p_network text,p_sub text,p_email text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare owner_wallet text; consumed integer;
begin
  if p_sub is null or length(p_sub) not between 1 and 255
    or p_email is null or length(p_email) not between 3 and 254 then return false; end if;
  select wallet into owner_wallet from public.account_google_states where state_hash=p_state_hash
    and browser_hash=p_browser_hash and network=p_network and expires_at > clock_timestamp();
  if not found then return false; end if;
  -- Both completion and unlink lock the profile before changing state rows.
  perform 1 from public.account_profiles where network=p_network and wallet=owner_wallet for update;
  delete from public.account_google_states where state_hash=p_state_hash and browser_hash=p_browser_hash
    and network=p_network and wallet=owner_wallet and expires_at > clock_timestamp();
  get diagnostics consumed = row_count;
  if consumed <> 1 then return false; end if;
  update public.account_profiles set google_sub=p_sub,google_email=p_email,google_linked_at=clock_timestamp()
    where network=p_network and wallet=owner_wallet;
  return true;
end;
$$;

create function public.unlink_account_google(p_wallet text,p_network text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.account_profiles where network=p_network and wallet=p_wallet for update;
  if not found then return false; end if;
  delete from public.account_google_states where network=p_network and wallet=p_wallet;
  update public.account_profiles set google_sub=null,google_email=null,google_linked_at=null
    where network=p_network and wallet=p_wallet;
  return true;
end;
$$;

revoke all on function public.consume_account_rate_limit(text,integer,integer),
  public.request_account_email_verification(text,text,text,text,text),
  public.verify_account_email(text,text,text),public.cancel_account_email_verification(text,text,text),
  public.complete_account_google_link(text,text,text,text,text),public.unlink_account_google(text,text)
  from public,anon,authenticated;
grant execute on function public.consume_account_rate_limit(text,integer,integer),
  public.request_account_email_verification(text,text,text,text,text),
  public.verify_account_email(text,text,text),public.cancel_account_email_verification(text,text,text),
  public.complete_account_google_link(text,text,text,text,text),public.unlink_account_google(text,text)
  to service_role;
commit;
