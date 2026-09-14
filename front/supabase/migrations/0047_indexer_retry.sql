-- 0047: persistent webhook jobs, one shared typed snapshot path, tombstones and
-- readiness. Deploy matching Next worker + shared generated SDK, configure the
-- authenticated scheduler, then switch Helius receiver to durable queue mode.
-- Reconcile current v2 and explicit read-only legacy v1 views. This migration
-- never invents lifetime issuance counters for legacy accounts.
begin;

-- A PDA is deterministic across clusters; metadata uniqueness must include network.
alter table public.asset_profiles drop constraint asset_profiles_pkey;
alter table public.asset_profiles add primary key(network,asset_pda);
alter table public.issuer_profiles drop constraint issuer_profiles_pkey;
alter table public.issuer_profiles add primary key(network,issuer_pda);

create table public.indexer_jobs (
  id uuid primary key default gen_random_uuid(), network text not null,
  signature text not null, slot bigint, wallets text[] not null default '{}',
  status text not null default 'pending' check (status in ('pending','complete')),
  attempts integer not null default 0, next_attempt_at timestamptz not null default now(),
  lease_owner uuid, lease_expires_at timestamptz, last_error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(network,signature)
);
create index indexer_jobs_due_idx on public.indexer_jobs(network,next_attempt_at) where status='pending';
alter table public.indexer_jobs enable row level security;
revoke all on public.indexer_jobs from public,anon,authenticated;
grant all on public.indexer_jobs to service_role;

create table public.indexer_account_versions (
  network text not null, pda text not null, slot bigint not null,
  table_name text, closed boolean not null default false,
  primary key(network,pda)
);
alter table public.indexer_account_versions enable row level security;
revoke all on public.indexer_account_versions from public,anon,authenticated;
grant all on public.indexer_account_versions to service_role;

-- Only operational freshness, never raw jobs or error details, is public.
create table public.indexer_sync_state (
  network text primary key, status text not null default 'warming' check(status in ('warming','ready','degraded')),
  last_slot bigint, completed_at timestamptz, checked_at timestamptz not null default now()
);
alter table public.indexer_sync_state enable row level security;
revoke all on public.indexer_sync_state from public,anon,authenticated;
create policy "public indexer freshness" on public.indexer_sync_state for select to anon,authenticated using(true);
grant select on public.indexer_sync_state to anon,authenticated;
grant all on public.indexer_sync_state to service_role;

alter table public.issuers add column if not exists version integer;
alter table public.assets add column if not exists extra_kyc_registry text, add column if not exists jurisdiction_rules jsonb;
alter table public.sales add column if not exists raise_type integer, add column if not exists cliff_months integer, add column if not exists vesting_months integer;
alter table public.custody_vaults add column if not exists beneficiary text;
alter table public.offers add column if not exists expires_at bigint;
alter table public.share_classes
  add column if not exists convertible_to text,
  add column if not exists lifetime_minted numeric(20,0),
  add column if not exists cumulative_cap boolean,
  add column if not exists readonly_legacy boolean;

do $$ declare t text; begin
  foreach t in array array['platforms','issuers','assets','share_classes','sales','custody_vaults','offers','proposals','vote_records','rights_issuances','milestones','milestone_claims','kyc_registries','kyc_entries'] loop
    execute format('alter table public.%I add column if not exists layout_version integer, add column if not exists account_version integer',t);
    execute format('insert into public.indexer_account_versions(network,pda,slot,table_name,closed) select network,pda,coalesce(last_slot,0),%L,false from public.%I on conflict(network,pda) do update set slot=excluded.slot,table_name=excluded.table_name where excluded.slot>indexer_account_versions.slot',t,t);
  end loop;
end $$;

create or replace function public.enqueue_indexer_event(
  p_network text,p_signature text,p_slot bigint,p_block_time timestamptz,
  p_ix_name text,p_wallets text[],p_payload jsonb
) returns uuid language plpgsql security definer set search_path='' as $$
declare job_id uuid;
begin
  if p_network is null or p_network not in ('mainnet','devnet','testnet','localnet') or p_signature is null or p_signature !~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$'
    or coalesce(array_length(p_wallets,1),0)>500 or p_slot<0 or jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'Invalid indexer event' using errcode='22023';
  end if;
  insert into public.indexer_events(network,signature,slot,block_time,program,ix_name,decoded,wallets,payload)
    values(p_network,p_signature,p_slot,p_block_time,'FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS',p_ix_name,false,p_wallets,p_payload)
    on conflict(network,signature) do nothing;
  insert into public.indexer_jobs(network,signature,slot,wallets)
    values(p_network,p_signature,p_slot,p_wallets) on conflict(network,signature) do nothing;
  select id into job_id from public.indexer_jobs where network=p_network and signature=p_signature;
  return job_id;
end $$;

-- One provider batch is one transaction: acknowledge only once every event and
-- durable retry job exists, including duplicate deliveries.
create or replace function public.enqueue_indexer_events(p_network text,p_events jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare event jsonb; n integer:=0;
begin
  if jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events) not between 1 and 100 then
    raise exception 'Invalid indexer event batch' using errcode='22023';
  end if;
  for event in select value from jsonb_array_elements(p_events) loop
    perform public.enqueue_indexer_event(p_network,event->>'signature',(event->>'slot')::bigint,
      (event->>'block_time')::timestamptz,event->>'ix_name',
      array(select jsonb_array_elements_text(event->'wallets')),event->'payload');
    n:=n+1;
  end loop;
  return n;
end $$;

create or replace function public.claim_indexer_jobs(p_network text,p_owner uuid,p_limit integer default 1,p_lease_seconds integer default 90)
returns setof public.indexer_jobs language plpgsql security definer set search_path='' as $$
begin
  if p_owner is null or p_limit not between 1 and 20 or p_lease_seconds not between 60 and 300 then
    raise exception 'Invalid indexer lease' using errcode='22023';
  end if;
  return query with picked as (
    select id from public.indexer_jobs where network=p_network and status='pending'
      and next_attempt_at<=clock_timestamp() and (lease_expires_at is null or lease_expires_at<=clock_timestamp())
      order by next_attempt_at,id for update skip locked limit p_limit
  ) update public.indexer_jobs j set lease_owner=p_owner,lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
    attempts=j.attempts+1,updated_at=clock_timestamp() from picked where j.id=picked.id returning j.*;
end $$;

create or replace function public.finish_indexer_job(p_id uuid,p_owner uuid,p_complete boolean,p_error text default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare job public.indexer_jobs%rowtype;
begin
  select * into job from public.indexer_jobs where id=p_id and lease_owner=p_owner and lease_expires_at>clock_timestamp() for update;
  if not found then return false; end if;
  update public.indexer_jobs set status=case when p_complete then 'complete' else 'pending' end,
    lease_owner=null,lease_expires_at=null,last_error=case when p_complete then null else left(p_error,240) end,
    next_attempt_at=clock_timestamp()+make_interval(secs=>least(3600,30*power(2,least(job.attempts,7)))::integer),updated_at=clock_timestamp()
    where id=p_id;
  if p_complete then
    update public.indexer_events set decoded=true where network=job.network and signature=job.signature;
    if not found then raise exception 'Indexer event acknowledgement target missing'; end if;
    update public.indexer_sync_state set status='ready',checked_at=clock_timestamp() where network=job.network and completed_at is not null
      and not exists(select 1 from public.indexer_jobs where network=job.network and status='pending');
  else
    insert into public.indexer_sync_state(network,status,checked_at) values(job.network,'degraded',clock_timestamp())
      on conflict(network) do update set status='degraded',checked_at=excluded.checked_at;
  end if;
  return true;
end $$;

-- Snapshot updates AND deletions serialize on each network/PDA. A tombstone
-- keeps an older in-flight snapshot from resurrecting a closed account.
create or replace function public.apply_indexer_snapshot(p_network text,p_slot bigint,p_rows jsonb,p_closed text[],p_signature text,p_layout_version integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  item jsonb; payload jsonb; target text; addr text; t text; cols text; updates text;
  known public.indexer_account_versions%rowtype; changed integer; written integer:=0; removed integer:=0; stale integer:=0;
  applied jsonb:='[]'; deleted jsonb:='{}';
  tables text[]:=array['platforms','issuers','assets','share_classes','sales','custody_vaults','offers','proposals','vote_records','rights_issuances','milestones','milestone_claims','kyc_registries','kyc_entries'];
begin
  if p_network is null or p_network not in ('mainnet','devnet','testnet','localnet') or p_slot is null or p_slot<0 or p_layout_version is distinct from 2
    or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>100 or coalesce(array_length(p_closed,1),0)>100 then
    raise exception 'Invalid indexer snapshot' using errcode='22023';
  end if;
  -- Lock the union in one order before mutation, even for mixed live/closed batches.
  for addr in select pda from (
    select value->'row'->>'pda' pda from jsonb_array_elements(p_rows)
    union select unnest(coalesce(p_closed,'{}'))
  ) addresses order by pda loop
    if addr is null or addr !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' then raise exception 'Invalid account address'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('indexer:'||p_network||':'||addr,0));
  end loop;
  for item in select value from jsonb_array_elements(p_rows) order by value->'row'->>'pda' loop
    target:=item->>'table'; payload:=item->'row'; addr:=payload->>'pda';
    if target is null or not(target=any(tables)) or addr is null or addr !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
      or jsonb_typeof(payload) is distinct from 'object' or jsonb_typeof(payload->'raw') is distinct from 'object' then
      raise exception 'Invalid typed indexer row' using errcode='22023';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('indexer:'||p_network||':'||addr,0));
    select * into known from public.indexer_account_versions where network=p_network and pda=addr;
    if found and (known.slot>p_slot or (known.closed and known.slot>=p_slot)) then stale:=stale+1; continue; end if;
    if target='share_classes' then
      if payload->>'account_version'='1' then
        if payload->'lifetime_minted' is distinct from 'null'::jsonb or payload->'cumulative_cap' is distinct from 'null'::jsonb or payload->>'readonly_legacy' is distinct from 'true' then
          raise exception 'Legacy ShareClass must have unknown ledger and read-only marker';
        end if;
      elsif payload->>'account_version'='2' then
        if jsonb_typeof(payload->'lifetime_minted') is distinct from 'string' or jsonb_typeof(payload->'cumulative_cap') is distinct from 'boolean' or payload->>'readonly_legacy' is distinct from 'false' then
          raise exception 'ShareClass v2 issuance ledger is required';
        end if;
      else raise exception 'Unsupported ShareClass version'; end if;
    end if;
    if known.table_name is not null and known.table_name<>target then
      execute format('delete from public.%I where network=$1 and pda=$2 and last_slot<=$3',known.table_name) using p_network,addr,p_slot;
    end if;
    payload:=payload||jsonb_build_object('network',p_network,'last_slot',p_slot,'last_signature',p_signature,'layout_version',p_layout_version,'updated_at',clock_timestamp());
    -- Reject schema drift, including a missing new column; never silently omit
    -- part of a decoded account and acknowledge its job as complete.
    if exists(select 1 from jsonb_object_keys(payload) k where not exists(
      select 1 from information_schema.columns c where c.table_schema='public' and c.table_name=target and c.column_name=k
    )) then raise exception 'Indexer table % is missing a decoded column',target; end if;
    select string_agg(format('%I',k),',' order by k),string_agg(format('%I=excluded.%I',k,k),',' order by k) filter(where k not in ('network','pda'))
      into cols,updates from jsonb_object_keys(payload) k;
    insert into public.indexer_account_versions(network,pda,slot,table_name,closed) values(p_network,addr,p_slot,target,false)
      on conflict(network,pda) do update set slot=excluded.slot,table_name=excluded.table_name,closed=false;
    execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I,$1) on conflict(network,pda) do update set %s',target,cols,cols,target,updates) using payload;
    get diagnostics changed=row_count;
    written:=written+changed;
    if changed>0 then applied:=applied||to_jsonb(addr); end if;
  end loop;
  for addr in select distinct unnest(coalesce(p_closed,'{}')) order by 1 loop
    if addr is null or addr !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' then raise exception 'Invalid closed account address'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('indexer:'||p_network||':'||addr,0));
    select * into known from public.indexer_account_versions where network=p_network and pda=addr;
    if found and known.slot>p_slot then stale:=stale+1; continue; end if;
    insert into public.indexer_account_versions(network,pda,slot,table_name,closed) values(p_network,addr,p_slot,null,true)
      on conflict(network,pda) do update set slot=excluded.slot,table_name=null,closed=true;
    foreach t in array tables loop
      execute format('delete from public.%I where network=$1 and pda=$2 and (last_slot is null or last_slot<=$3)',t) using p_network,addr,p_slot;
      get diagnostics changed=row_count;
      removed:=removed+changed;
      if changed>0 then deleted:=jsonb_set(deleted,array[t],coalesce(deleted->t,'[]')||to_jsonb(addr),true); end if;
    end loop;
  end loop;
  return jsonb_build_object('written',written,'closed',removed,'stale',stale,'applied',applied,'deleted',deleted);
end $$;

create or replace function public.indexer_reject_stale_slot() returns trigger language plpgsql set search_path='' as $$
declare known public.indexer_account_versions%rowtype;
begin
  if new.layout_version is distinct from 2 or new.last_slot is null then raise exception 'Indexer snapshot v2 is required'; end if;
  select * into known from public.indexer_account_versions where network=new.network and pda=new.pda;
  if found and (known.slot>new.last_slot or (known.closed and known.slot>=new.last_slot)) then return null; end if;
  if tg_op='UPDATE' and old.last_slot is not null and new.last_slot<old.last_slot then return null; end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['platforms','issuers','assets','share_classes','sales','custody_vaults','offers','proposals','vote_records','rights_issuances','milestones','milestone_claims','kyc_registries','kyc_entries'] loop
    execute format('drop trigger if exists %I on public.%I',t||'_reject_stale_slot',t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function public.indexer_reject_stale_slot()',t||'_reject_stale_slot',t);
  end loop;
end $$;

revoke all on function public.enqueue_indexer_events(text,jsonb) from public,anon,authenticated;
grant execute on function public.enqueue_indexer_events(text,jsonb) to service_role;
revoke all on function public.enqueue_indexer_event(text,text,bigint,timestamptz,text,text[],jsonb) from public,anon,authenticated;
revoke all on function public.claim_indexer_jobs(text,uuid,integer,integer) from public,anon,authenticated;
revoke all on function public.finish_indexer_job(uuid,uuid,boolean,text) from public,anon,authenticated;
revoke all on function public.apply_indexer_snapshot(text,bigint,jsonb,text[],text,integer) from public,anon,authenticated;
grant execute on function public.enqueue_indexer_event(text,text,bigint,timestamptz,text,text[],jsonb) to service_role;
grant execute on function public.claim_indexer_jobs(text,uuid,integer,integer) to service_role;
grant execute on function public.finish_indexer_job(uuid,uuid,boolean,text) to service_role;
grant execute on function public.apply_indexer_snapshot(text,bigint,jsonb,text[],text,integer) to service_role;

-- BEGIN retry-worker leases
-- One deployment network at a time, independent of application worker count.
create table if not exists public.retry_worker_leases (
  network text primary key check (network in ('mainnet', 'devnet', 'testnet', 'localnet')),
  owner uuid not null,
  expires_at timestamptz not null
);
alter table public.retry_worker_leases enable row level security;
revoke all on public.retry_worker_leases from public, anon, authenticated;
grant all on public.retry_worker_leases to service_role;

create or replace function public.acquire_retry_worker_lease(
  p_network text, p_owner uuid, p_ttl_seconds integer default 120
) returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare acquired integer;
begin
  if p_network is null or p_network not in ('mainnet', 'devnet', 'testnet', 'localnet')
    or p_owner is null or p_ttl_seconds is null or p_ttl_seconds < 60 or p_ttl_seconds > 300 then
    raise exception 'Invalid retry worker lease parameters' using errcode = '22023';
  end if;
  insert into public.retry_worker_leases as leases(network, owner, expires_at)
    values (p_network, p_owner, clock_timestamp() + make_interval(secs => p_ttl_seconds))
  on conflict (network) do update
    set owner = excluded.owner, expires_at = excluded.expires_at
    where leases.expires_at <= clock_timestamp();
  get diagnostics acquired = row_count;
  return acquired = 1;
end;
$$;

create or replace function public.release_retry_worker_lease(p_network text, p_owner uuid)
returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare released integer;
begin
  delete from public.retry_worker_leases where network = p_network and owner = p_owner;
  get diagnostics released = row_count;
  return released = 1;
end;
$$;
revoke all on function public.acquire_retry_worker_lease(text, uuid, integer) from public, anon, authenticated;
revoke all on function public.release_retry_worker_lease(text, uuid) from public, anon, authenticated;
grant execute on function public.acquire_retry_worker_lease(text, uuid, integer) to service_role;
grant execute on function public.release_retry_worker_lease(text, uuid) to service_role;
-- END retry-worker leases

commit;
