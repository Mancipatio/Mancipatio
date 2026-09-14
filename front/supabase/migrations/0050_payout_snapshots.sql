-- Original investor entitlements and proofs survive changes to live balances.
-- Prepared data is immutable; bound status requires the server's finalized
-- owner/PDA/root/total verification. No public projection exposes wallet lists.
begin;
create table public.payout_snapshots (
  id uuid primary key default gen_random_uuid(),
  network text not null check(network in ('mainnet','devnet','testnet','localnet')),
  kind text not null check(kind in ('vault_vote','investor_yield','legacy_vault_vote')),
  target_pda text not null,
  round numeric(20,0) not null check(round>=0 and round<=18446744073709551615),
  root_hex text not null check(root_hex ~ '^[a-f0-9]{64}$' and root_hex<>repeat('0',64)),
  rows_hash text not null check(rows_hash ~ '^[a-f0-9]{64}$'),
  total_weight numeric(20,0) not null check(total_weight>0 and total_weight<=18446744073709551615),
  entry_count integer not null check(entry_count between 1 and 5000),
  created_by text not null, created_at timestamptz not null default now(),
  status text not null default 'prepared' check(status in ('prepared','bound')),
  bound_at timestamptz, bound_slot bigint,
  unique(network,kind,target_pda,round,root_hex),
  check((kind in ('investor_yield','legacy_vault_vote') and round=0) or (kind='vault_vote' and round>0)),
  check((status='prepared' and bound_at is null and bound_slot is null) or (status='bound' and bound_at is not null and bound_slot is not null and bound_slot>=0))
);
create unique index payout_snapshot_bound_identity on public.payout_snapshots(network,kind,target_pda,round) where status='bound';
create table public.payout_snapshot_entries (
  snapshot_id uuid not null references public.payout_snapshots(id),
  wallet text not null, weight numeric(20,0) not null check(weight>0 and weight<=18446744073709551615),
  proof jsonb not null check(jsonb_typeof(proof)='array' and jsonb_array_length(proof)<=13),
  primary key(snapshot_id,wallet)
);
alter table public.payout_snapshots enable row level security;
alter table public.payout_snapshot_entries enable row level security;
revoke all on public.payout_snapshots,public.payout_snapshot_entries from public,anon,authenticated,service_role;
grant select on public.payout_snapshots,public.payout_snapshot_entries to service_role;

create or replace function public.prepare_payout_snapshot(p_snapshot jsonb,p_entries jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result public.payout_snapshots%rowtype; n integer; total numeric;
begin
  if jsonb_typeof(p_snapshot) is distinct from 'object' or jsonb_typeof(p_entries) is distinct from 'array' or jsonb_array_length(p_entries) not between 1 and 5000 then
    raise exception 'Invalid payout snapshot' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(p_entries) e where e->>'wallet' is null or e->>'wallet' !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    or e->>'weight' is null or e->>'weight' !~ '^[1-9][0-9]{0,19}$' or jsonb_typeof(e->'proof') is distinct from 'array') then
    raise exception 'Invalid snapshot entry' using errcode='22023';
  end if;
  select count(*),sum((e->>'weight')::numeric) into n,total from jsonb_array_elements(p_entries) e;
  if n<>(p_snapshot->>'entry_count')::integer or total<>(p_snapshot->>'total_weight')::numeric or n<>(select count(distinct e->>'wallet') from jsonb_array_elements(p_entries) e) then
    raise exception 'Snapshot entries do not match count/total' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(p_entries) e cross join lateral jsonb_array_elements_text(e->'proof') h where h !~ '^[a-f0-9]{64}$') then
    raise exception 'Invalid snapshot proof' using errcode='22023';
  end if;
  insert into public.payout_snapshots(network,kind,target_pda,round,root_hex,rows_hash,total_weight,entry_count,created_by)
    values(p_snapshot->>'network',p_snapshot->>'kind',p_snapshot->>'target_pda',(p_snapshot->>'round')::numeric,p_snapshot->>'root_hex',
      p_snapshot->>'rows_hash',(p_snapshot->>'total_weight')::numeric,n,p_snapshot->>'created_by')
    on conflict(network,kind,target_pda,round,root_hex) do nothing returning * into result;
  if not found then
    select * into result from public.payout_snapshots where network=p_snapshot->>'network' and kind=p_snapshot->>'kind'
      and target_pda=p_snapshot->>'target_pda' and round=(p_snapshot->>'round')::numeric and root_hex=p_snapshot->>'root_hex';
    if result.rows_hash is distinct from p_snapshot->>'rows_hash' or result.total_weight<>total or result.entry_count<>n then
      raise exception 'Immutable snapshot content conflict';
    end if;
    return to_jsonb(result)||jsonb_build_object('round',result.round::text,'total_weight',result.total_weight::text,'bound_slot',result.bound_slot::text);
  end if;
  insert into public.payout_snapshot_entries(snapshot_id,wallet,weight,proof)
    select result.id,e->>'wallet',(e->>'weight')::numeric,e->'proof' from jsonb_array_elements(p_entries) e;
  return to_jsonb(result)||jsonb_build_object('round',result.round::text,'total_weight',result.total_weight::text,'bound_slot',result.bound_slot::text);
end $$;
create or replace function public.bind_payout_snapshot(p_id uuid,p_network text,p_root text,p_total numeric,p_slot bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result public.payout_snapshots%rowtype;
begin
  select * into result from public.payout_snapshots where id=p_id and network=p_network for update;
  if not found or result.root_hex is distinct from p_root or result.total_weight is distinct from p_total or p_slot is null or p_slot<0 then
    raise exception 'Snapshot binding mismatch' using errcode='22023';
  end if;
  if result.status='bound' then return to_jsonb(result)||jsonb_build_object('round',result.round::text,'total_weight',result.total_weight::text,'bound_slot',result.bound_slot::text); end if;
  update public.payout_snapshots set status='bound',bound_at=clock_timestamp(),bound_slot=p_slot where id=p_id returning * into result;
  return to_jsonb(result)||jsonb_build_object('round',result.round::text,'total_weight',result.total_weight::text,'bound_slot',result.bound_slot::text);
end $$;
revoke all on function public.prepare_payout_snapshot(jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.bind_payout_snapshot(uuid,text,text,numeric,bigint) from public,anon,authenticated;
grant execute on function public.prepare_payout_snapshot(jsonb,jsonb) to service_role;
grant execute on function public.bind_payout_snapshot(uuid,text,text,numeric,bigint) to service_role;
-- Cast u64 fields at the DB boundary so JSON cannot round large entitlements.
create view public.payout_snapshot_metadata with (security_invoker=true) as
  select id,network,kind,target_pda,round::text,root_hex,rows_hash,total_weight::text,entry_count,created_by,created_at,status,bound_at,bound_slot::text from public.payout_snapshots;
create view public.payout_snapshot_proofs with (security_invoker=true) as
  select snapshot_id,wallet,weight::text,proof from public.payout_snapshot_entries;
revoke all on public.payout_snapshot_metadata,public.payout_snapshot_proofs from public,anon,authenticated;
grant select on public.payout_snapshot_metadata,public.payout_snapshot_proofs to service_role;
commit;
