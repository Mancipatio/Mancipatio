-- Shared contact accounts with two-wallet ownership proof. No KYC or chain data changes.
-- Apply after 0052. Every existing profile keeps its data and original member.
begin;

alter table public.account_profiles add column id uuid not null default gen_random_uuid();
alter table public.account_profiles add column primary_wallet text;
alter table public.account_profiles add column pending_email_requested_by text;
update public.account_profiles set primary_wallet=wallet,
  pending_email_requested_by=case when pending_email is not null then wallet end;
alter table public.account_profiles alter column primary_wallet set not null;
alter table public.account_profiles add constraint account_profiles_id_network_key unique(id,network);

create table public.account_wallets (
  network text not null,
  wallet text not null check(wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  account_id uuid not null,
  linked_at timestamptz not null default clock_timestamp(),
  primary key(network,wallet),
  unique(account_id,network,wallet),
  foreign key(account_id,network) references public.account_profiles(id,network) on delete cascade
);
insert into public.account_wallets(network,wallet,account_id,linked_at)
  select network,wallet,id,created_at from public.account_profiles;

alter table public.account_email_requests add column account_id uuid;
update public.account_email_requests r set account_id=p.id from public.account_profiles p
  where p.network=r.network and p.wallet=r.wallet;
alter table public.account_email_requests alter column account_id set not null;
alter table public.account_email_requests drop constraint account_email_requests_network_wallet_fkey;
alter table public.account_email_requests add foreign key(account_id,network)
  references public.account_profiles(id,network) on delete cascade;
create index account_email_account_time on public.account_email_requests(account_id,created_at);

alter table public.account_google_states add column account_id uuid;
update public.account_google_states s set account_id=p.id from public.account_profiles p
  where p.network=s.network and p.wallet=s.wallet;
alter table public.account_google_states alter column account_id set not null;
alter table public.account_google_states drop constraint account_google_states_network_wallet_fkey;
alter table public.account_google_states add foreign key(account_id,network,wallet)
  references public.account_wallets(account_id,network,wallet) on delete cascade;

alter table public.account_profiles drop constraint account_profiles_pkey;
alter table public.account_profiles add primary key(id);
alter table public.account_profiles add constraint account_profiles_primary_member
  foreign key(id,network,primary_wallet) references public.account_wallets(account_id,network,wallet)
  deferrable initially deferred;
comment on column public.account_profiles.wallet is 'Historical first wallet; NOT an authorization field. Use account_wallets.';

create table public.account_wallet_links (
  token_hash text primary key check(token_hash ~ '^[0-9a-f]{64}$'),
  account_id uuid not null,
  network text not null,
  requested_by text not null,
  target_wallet text not null check(target_wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  foreign key(account_id,network,requested_by) references public.account_wallets(account_id,network,wallet) on delete cascade,
  check(requested_by <> target_wallet),
  check(expires_at > created_at and expires_at <= created_at + interval '10 minutes')
);
create index account_wallet_links_owner on public.account_wallet_links(account_id,requested_by);
create index account_wallet_links_expiry on public.account_wallet_links(expires_at);
alter table public.account_wallets enable row level security;
alter table public.account_wallet_links enable row level security;
revoke all on public.account_wallets,public.account_wallet_links from public,anon,authenticated;
grant all on public.account_wallets,public.account_wallet_links to service_role;

-- Every mutation/removal locks the account first and then rechecks membership.
-- A detached wallet never retains access through a stale profile lookup.
create function public.lock_account_for_wallet(p_wallet text,p_network text) returns uuid
language plpgsql security definer set search_path='' as $$
declare owner_id uuid;
begin
  select account_id into owner_id from public.account_wallets where network=p_network and wallet=p_wallet;
  if owner_id is null then return null; end if;
  perform 1 from public.account_profiles where id=owner_id and network=p_network for update;
  if not found or not exists(select 1 from public.account_wallets where account_id=owner_id and network=p_network and wallet=p_wallet) then
    return null;
  end if;
  return owner_id;
end;
$$;

create function public.ensure_account_profile(p_wallet text,p_network text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare owner_id uuid; result jsonb;
begin
  -- This same lock serializes creation with a target wallet's link completion.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-wallet:'||p_network||':'||p_wallet,0));
  owner_id:=public.lock_account_for_wallet(p_wallet,p_network);
  if owner_id is null then
    insert into public.account_profiles(network,wallet,primary_wallet) values(p_network,p_wallet,p_wallet) returning id into owner_id;
    insert into public.account_wallets(network,wallet,account_id) values(p_network,p_wallet,owner_id);
  end if;
  select jsonb_build_object(
    'id',p.id,'wallet',p_wallet,'network',p.network,'primary_wallet',p.primary_wallet,
    'wallets',(select coalesce(jsonb_agg(jsonb_build_object('wallet',w.wallet,'linked_at',w.linked_at) order by w.linked_at,w.wallet),'[]'::jsonb)
      from public.account_wallets w where w.account_id=p.id and w.network=p.network),
    'display_name',p.display_name,'email',p.email,'email_verified_at',p.email_verified_at,
    'pending_email',p.pending_email,'pending_email_expires_at',p.pending_email_expires_at,
    'google_email',p.google_email,'google_linked_at',p.google_linked_at,'created_at',p.created_at,'updated_at',p.updated_at)
    into result from public.account_profiles p where p.id=owner_id;
  return result;
end;
$$;

create function public.update_account_display_name(p_wallet text,p_network text,p_display_name text) returns boolean
language plpgsql security definer set search_path='' as $$
declare owner_id uuid;
begin
  if p_display_name is null or length(p_display_name)>100 or p_display_name ~ '[[:cntrl:]]' then return false; end if;
  owner_id:=public.lock_account_for_wallet(p_wallet,p_network);
  if owner_id is null then return false; end if;
  update public.account_profiles set display_name=p_display_name where id=owner_id;
  return true;
end;
$$;

create or replace function public.request_account_email_verification(
  p_wallet text,p_network text,p_email text,p_token_hash text,p_recipient_hash text
) returns text language plpgsql security definer set search_path='' as $$
declare owner_id uuid; now_at timestamptz:=clock_timestamp();
begin
  if p_email is null or length(p_email) not between 3 and 254 or p_email<>lower(btrim(p_email))
    or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
    or p_recipient_hash is null or p_recipient_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid verification request'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-email:'||p_recipient_hash,0));
  owner_id:=public.lock_account_for_wallet(p_wallet,p_network);
  if owner_id is null then return 'not_member'; end if;
  if exists(select 1 from public.account_email_requests where network=p_network and (account_id=owner_id or wallet=p_wallet)
      and created_at>now_at-interval '60 seconds')
    or (select count(*) from public.account_email_requests where network=p_network and (account_id=owner_id or wallet=p_wallet)
      and created_at>now_at-interval '1 hour')>=5
    or (select count(*) from public.account_email_requests where recipient_hash=p_recipient_hash
      and created_at>now_at-interval '1 hour')>=10 then return 'rate_limited'; end if;
  insert into public.account_email_requests(token_hash,network,wallet,account_id,recipient_hash,created_at)
    values(p_token_hash,p_network,p_wallet,owner_id,p_recipient_hash,now_at);
  update public.account_profiles set pending_email=p_email,pending_email_token_hash=p_token_hash,
    pending_email_requested_by=p_wallet,pending_email_expires_at=now_at+interval '30 minutes' where id=owner_id;
  delete from public.account_email_requests where token_hash in (
    select token_hash from public.account_email_requests where created_at<now_at-interval '1 day' order by created_at limit 100 for update skip locked);
  return 'requested';
end;
$$;

create or replace function public.verify_account_email(p_wallet text,p_network text,p_token_hash text) returns boolean
language plpgsql security definer set search_path='' as $$
declare owner_id uuid; changed integer;
begin
  owner_id:=public.lock_account_for_wallet(p_wallet,p_network);
  if owner_id is null then return false; end if;
  update public.account_profiles p set email=pending_email,email_verified_at=clock_timestamp(),
    pending_email=null,pending_email_token_hash=null,pending_email_expires_at=null,pending_email_requested_by=null
    where id=owner_id and pending_email_token_hash=p_token_hash and pending_email_expires_at>clock_timestamp()
      and exists(select 1 from public.account_wallets w where w.account_id=owner_id and w.network=p_network and w.wallet=p.pending_email_requested_by);
  get diagnostics changed=row_count; return changed=1;
end;
$$;

create or replace function public.cancel_account_email_verification(p_wallet text,p_network text,p_token_hash text default null) returns boolean
language plpgsql security definer set search_path='' as $$
declare owner_id uuid; changed integer;
begin
  owner_id:=public.lock_account_for_wallet(p_wallet,p_network);
  if owner_id is null then return false; end if;
  update public.account_profiles set pending_email=null,pending_email_token_hash=null,pending_email_expires_at=null,pending_email_requested_by=null
    where id=owner_id and pending_email_token_hash is not null and (p_token_hash is null or pending_email_token_hash=p_token_hash);
  get diagnostics changed=row_count; return changed=1;
end;
$$;

create or replace function public.complete_account_google_link(
  p_state_hash text,p_browser_hash text,p_network text,p_sub text,p_email text
) returns boolean language plpgsql security definer set search_path='' as $$
declare owner_id uuid; initiator text; consumed integer;
begin
  if p_sub is null or length(p_sub) not between 1 and 255 or p_email is null or length(p_email) not between 3 and 254 then return false; end if;
  select account_id,wallet into owner_id,initiator from public.account_google_states
    where state_hash=p_state_hash and browser_hash=p_browser_hash and network=p_network and expires_at>clock_timestamp();
  if owner_id is null then return false; end if;
  if public.lock_account_for_wallet(initiator,p_network) is distinct from owner_id then return false; end if;
  delete from public.account_google_states where state_hash=p_state_hash and browser_hash=p_browser_hash
    and network=p_network and account_id=owner_id and wallet=initiator and expires_at>clock_timestamp();
  get diagnostics consumed=row_count; if consumed<>1 then return false; end if;
  update public.account_profiles set google_sub=p_sub,google_email=p_email,google_linked_at=clock_timestamp() where id=owner_id;
  return true;
end;
$$;

create or replace function public.unlink_account_google(p_wallet text,p_network text) returns boolean
language plpgsql security definer set search_path='' as $$
declare owner_id uuid;
begin
  owner_id:=public.lock_account_for_wallet(p_wallet,p_network); if owner_id is null then return false; end if;
  delete from public.account_google_states where account_id=owner_id;
  update public.account_profiles set google_sub=null,google_email=null,google_linked_at=null where id=owner_id;
  return true;
end;
$$;

create function public.start_account_wallet_link(p_wallet text,p_network text,p_target_wallet text,p_token_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare owner_id uuid; expires timestamptz:=clock_timestamp()+interval '10 minutes';
begin
  if p_target_wallet is null or p_target_wallet !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid wallet proof'; end if;
  owner_id:=public.lock_account_for_wallet(p_wallet,p_network);
  if owner_id is null then return jsonb_build_object('status','not_member'); end if;
  if exists(select 1 from public.account_wallets where account_id=owner_id and wallet=p_target_wallet) then
    return jsonb_build_object('status','same_wallet'); end if;
  if (select count(*) from public.account_wallets where account_id=owner_id)>=10 then return jsonb_build_object('status','wallet_limit'); end if;
  if not public.consume_account_rate_limit(encode(sha256(convert_to('wallet-link:'||p_network||':'||p_wallet,'UTF8')),'hex'),5,600) then
    return jsonb_build_object('status','rate_limited'); end if;
  delete from public.account_wallet_links where account_id=owner_id and requested_by=p_wallet;
  insert into public.account_wallet_links(token_hash,account_id,network,requested_by,target_wallet,expires_at)
    values(p_token_hash,owner_id,p_network,p_wallet,p_target_wallet,expires);
  return jsonb_build_object('status','started','account_id',owner_id,'requested_by',p_wallet,'target_wallet',p_target_wallet,'expires_at',expires);
end;
$$;

create function public.complete_account_wallet_link(
  p_wallet text,p_network text,p_token_hash text,p_account_id uuid,p_requested_by text,p_target_wallet text
) returns text language plpgsql security definer set search_path='' as $$
declare target_account uuid; consumed integer;
begin
  if p_wallet is distinct from p_target_wallet then return 'invalid'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-wallet:'||p_network||':'||p_wallet,0));
  if not exists(select 1 from public.account_wallet_links where token_hash=p_token_hash and account_id=p_account_id
    and network=p_network and requested_by=p_requested_by and target_wallet=p_wallet and expires_at>clock_timestamp()) then return 'invalid'; end if;
  select account_id into target_account from public.account_wallets where network=p_network and wallet=p_wallet;
  -- Canonical order prevents two simultaneous cross-account link attempts from deadlocking.
  perform 1 from public.account_profiles where network=p_network and id in(p_account_id,target_account) order by id for update;
  if not exists(select 1 from public.account_wallets where account_id=p_account_id and network=p_network and wallet=p_requested_by)
    or not exists(select 1 from public.account_wallet_links where token_hash=p_token_hash and account_id=p_account_id
      and network=p_network and requested_by=p_requested_by and target_wallet=p_wallet and expires_at>clock_timestamp()) then return 'invalid'; end if;
  if (select account_id from public.account_wallets where network=p_network and wallet=p_wallet) is distinct from target_account then return 'invalid'; end if;
  if target_account=p_account_id then return 'account_conflict'; end if;
  if (select count(*) from public.account_wallets where account_id=p_account_id)>=10 then return 'wallet_limit'; end if;
  if target_account is not null then
    -- Only an untouched automatically-created singleton may be discarded.
    -- Never merge personal data, verified identities, pending proofs or history.
    if (select count(*) from public.account_wallets where account_id=target_account)<>1
      or not exists(select 1 from public.account_profiles where id=target_account and display_name=''
        and email is null and pending_email is null and google_sub is null and primary_wallet=p_wallet)
      or exists(select 1 from public.account_email_requests where account_id=target_account)
      or exists(select 1 from public.account_google_states where account_id=target_account)
      or exists(select 1 from public.account_wallet_links where account_id=target_account) then return 'account_conflict'; end if;
  end if;
  delete from public.account_wallet_links where token_hash=p_token_hash and account_id=p_account_id
    and requested_by=p_requested_by and target_wallet=p_wallet and network=p_network and expires_at>clock_timestamp();
  get diagnostics consumed=row_count; if consumed<>1 then return 'invalid'; end if;
  if target_account is not null then
    delete from public.account_wallets where account_id=target_account;
    delete from public.account_profiles where id=target_account;
  end if;
  insert into public.account_wallets(network,wallet,account_id) values(p_network,p_wallet,p_account_id);
  update public.account_profiles set updated_at=clock_timestamp() where id=p_account_id;
  return 'linked';
end;
$$;

create function public.set_account_primary_wallet(p_wallet text,p_network text,p_primary_wallet text) returns text
language plpgsql security definer set search_path='' as $$
declare owner_id uuid;
begin
  owner_id:=public.lock_account_for_wallet(p_wallet,p_network);
  if owner_id is null or not exists(select 1 from public.account_wallets where account_id=owner_id and network=p_network and wallet=p_primary_wallet) then return 'not_member'; end if;
  update public.account_profiles set primary_wallet=p_primary_wallet where id=owner_id;
  return 'updated';
end;
$$;

create function public.cancel_account_wallet_link(
  p_wallet text,p_network text,p_token_hash text,p_account_id uuid,p_requested_by text,p_target_wallet text
) returns boolean language plpgsql security definer set search_path='' as $$
begin
  if p_wallet is distinct from p_requested_by and p_wallet is distinct from p_target_wallet then return false; end if;
  perform 1 from public.account_profiles where id=p_account_id and network=p_network for update;
  if p_wallet=p_requested_by and not exists(select 1 from public.account_wallets
    where account_id=p_account_id and network=p_network and wallet=p_requested_by) then return false; end if;
  if exists(select 1 from public.account_wallet_links where token_hash=p_token_hash
    and (account_id<>p_account_id or network<>p_network or requested_by<>p_requested_by or target_wallet<>p_target_wallet)) then return false; end if;
  if not exists(select 1 from public.account_wallet_links where token_hash=p_token_hash)
    and exists(select 1 from public.account_wallets where account_id=p_account_id and network=p_network and wallet=p_target_wallet) then return false; end if;
  delete from public.account_wallet_links where token_hash=p_token_hash and account_id=p_account_id
    and network=p_network and requested_by=p_requested_by and target_wallet=p_target_wallet;
  return true;
end;
$$;

create function public.remove_account_wallet(p_wallet text,p_network text,p_target_wallet text) returns text
language plpgsql security definer set search_path='' as $$
declare owner_id uuid;
begin
  owner_id:=public.lock_account_for_wallet(p_wallet,p_network);
  if owner_id is null or not exists(select 1 from public.account_wallets where account_id=owner_id and network=p_network and wallet=p_target_wallet) then return 'not_member'; end if;
  if (select count(*) from public.account_wallets where account_id=owner_id)<=1 then return 'last'; end if;
  if p_target_wallet=p_wallet then return 'self'; end if;
  if exists(select 1 from public.account_profiles where id=owner_id and primary_wallet=p_target_wallet) then return 'primary'; end if;
  update public.account_profiles set pending_email=null,pending_email_token_hash=null,pending_email_expires_at=null,pending_email_requested_by=null
    where id=owner_id and pending_email_requested_by=p_target_wallet;
  -- Revoke older invitations TO the removed wallet as well as proofs it issued.
  -- Otherwise another member's pre-removal invitation could silently re-add it.
  delete from public.account_wallet_links where account_id=owner_id and network=p_network and target_wallet=p_target_wallet;
  -- FK cascades invalidate OAuth states and link proofs issued by this member.
  delete from public.account_wallets where account_id=owner_id and network=p_network and wallet=p_target_wallet;
  update public.account_profiles set updated_at=clock_timestamp() where id=owner_id;
  return 'removed';
end;
$$;

-- A signed intent names its expected stable account, not just the actor wallet.
-- Rechecking membership alone is insufficient if a wallet was detached/relinked
-- while the user was approving an older request.
create function public.mutate_account_profile(p_wallet text,p_network text,p_account_id uuid,p_action text,p_params jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare allowed text[]; owner_id uuid; result jsonb;
begin
  if p_params is null or jsonb_typeof(p_params)<>'object' or p_action is null then raise exception 'Invalid account mutation'; end if;
  case p_action
    when 'update' then allowed:=array['display_name'];
    when 'email.request' then allowed:=array['email','token_hash','recipient_hash'];
    when 'email.cancel' then allowed:=array['token_hash'];
    when 'google.unlink' then allowed:=array[]::text[];
    when 'wallets.start' then allowed:=array['target_wallet','token_hash'];
    when 'wallets.primary' then allowed:=array['wallet'];
    when 'wallets.remove' then allowed:=array['wallet'];
    else raise exception 'Invalid account mutation';
  end case;
  if not(p_params ?& allowed) or exists(select 1 from jsonb_object_keys(p_params) as key where not(key=any(allowed))) then
    raise exception 'Invalid account mutation fields';
  end if;
  if exists(select 1 from jsonb_each(p_params) as field where jsonb_typeof(field.value)<>'string'
    and not(p_action='email.cancel' and field.key='token_hash' and field.value='null'::jsonb)) then
    raise exception 'Invalid account mutation values';
  end if;
  if p_action='email.request' then
    if p_params->>'recipient_hash' is distinct from encode(sha256(convert_to(lower(btrim(p_params->>'email')),'UTF8')),'hex') then
      raise exception 'Invalid recipient hash';
    end if;
    -- Match the primitive's recipient-before-profile lock ordering.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-email:'||(p_params->>'recipient_hash'),0));
  end if;
  owner_id:=public.lock_account_for_wallet(p_wallet,p_network);
  if owner_id is null or owner_id is distinct from p_account_id then return jsonb_build_object('ok',false); end if;
  case p_action
    when 'update' then result:=to_jsonb(public.update_account_display_name(p_wallet,p_network,p_params->>'display_name'));
    when 'email.request' then result:=to_jsonb(public.request_account_email_verification(p_wallet,p_network,p_params->>'email',p_params->>'token_hash',p_params->>'recipient_hash'));
    when 'email.cancel' then result:=to_jsonb(public.cancel_account_email_verification(p_wallet,p_network,p_params->>'token_hash'));
    when 'google.unlink' then result:=to_jsonb(public.unlink_account_google(p_wallet,p_network));
    when 'wallets.start' then result:=public.start_account_wallet_link(p_wallet,p_network,p_params->>'target_wallet',p_params->>'token_hash');
    when 'wallets.primary' then result:=to_jsonb(public.set_account_primary_wallet(p_wallet,p_network,p_params->>'wallet'));
    when 'wallets.remove' then result:=to_jsonb(public.remove_account_wallet(p_wallet,p_network,p_params->>'wallet'));
  end case;
  return jsonb_build_object('ok',true,'result',result);
end;
$$;

revoke all on function public.mutate_account_profile(text,text,uuid,text,jsonb),public.lock_account_for_wallet(text,text),public.ensure_account_profile(text,text),
  public.update_account_display_name(text,text,text),public.start_account_wallet_link(text,text,text,text),
  public.complete_account_wallet_link(text,text,text,uuid,text,text),public.cancel_account_wallet_link(text,text,text,uuid,text,text),public.set_account_primary_wallet(text,text,text),
  public.remove_account_wallet(text,text,text) from public,anon,authenticated;
grant execute on function public.mutate_account_profile(text,text,uuid,text,jsonb),public.lock_account_for_wallet(text,text),public.ensure_account_profile(text,text),
  public.update_account_display_name(text,text,text),public.start_account_wallet_link(text,text,text,text),
  public.complete_account_wallet_link(text,text,text,uuid,text,text),public.cancel_account_wallet_link(text,text,text,uuid,text,text),public.set_account_primary_wallet(text,text,text),
  public.remove_account_wallet(text,text,text) to service_role;
commit;
