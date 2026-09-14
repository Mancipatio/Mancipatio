-- The funded distribution commits this immutable ordered batch plan on-chain.
-- Only signed server routes can prepare/read it or attest finalized binding.
begin;
create table public.distribution_plans (
  id uuid primary key default gen_random_uuid(),
  network text not null check(network in ('mainnet','devnet','testnet','localnet')),
  distribution_pda text not null,
  distribution_id numeric(20,0) not null check(distribution_id>=0 and distribution_id<=18446744073709551615),
  share_class text not null, payment_mint text not null, payment_token_program text not null, funder text not null,
  total_amount numeric(20,0) not null check(total_amount>0 and total_amount<=18446744073709551615),
  snapshot_supply numeric(20,0) not null check(snapshot_supply>0 and snapshot_supply<=18446744073709551615),
  allocated_amount numeric(20,0) not null check(allocated_amount>0 and allocated_amount=total_amount),
  root_hex text not null check(root_hex ~ '^[a-f0-9]{64}$' and root_hex<>repeat('0',64)),
  plan_hash text not null check(plan_hash ~ '^[a-f0-9]{64}$'),
  batch_count integer not null check(batch_count between 1 and 834),
  entry_count integer not null check(entry_count between 1 and 5000),
  created_by text not null check(created_by=funder), created_at timestamptz not null default now(),
  status text not null default 'prepared' check(status in ('prepared','bound')),
  bound_at timestamptz, bound_slot bigint,
  unique(network,distribution_pda),
  check((status='prepared' and bound_at is null and bound_slot is null) or
        (status='bound' and bound_at is not null and bound_slot is not null and bound_slot>=0))
);
create table public.distribution_plan_batches (
  plan_id uuid not null references public.distribution_plans(id),
  batch_id integer not null check(batch_id between 0 and 833),
  entries jsonb not null check(jsonb_typeof(entries)='array' and jsonb_array_length(entries) between 1 and 6),
  leaf_hex text not null check(leaf_hex ~ '^[a-f0-9]{64}$'),
  proof jsonb not null check(jsonb_typeof(proof)='array' and jsonb_array_length(proof)<=10),
  primary key(plan_id,batch_id)
);
alter table public.distribution_plans enable row level security;
alter table public.distribution_plan_batches enable row level security;
revoke all on public.distribution_plans,public.distribution_plan_batches from public,anon,authenticated,service_role;
grant select on public.distribution_plans,public.distribution_plan_batches to service_role;

create function public.prepare_distribution_plan(p_plan jsonb,p_batches jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare result public.distribution_plans%rowtype; n integer; total numeric; batch_n integer;
begin
  if jsonb_typeof(p_plan) is distinct from 'object' or jsonb_typeof(p_batches) is distinct from 'array' or jsonb_array_length(p_batches) not between 1 and 834 then
    raise exception 'Invalid distribution plan' using errcode='22023';
  end if;
  batch_n:=jsonb_array_length(p_batches);
  if exists(select 1 from jsonb_array_elements(p_batches) with ordinality b(value,position)
    where jsonb_typeof(value->'entries') is distinct from 'array' or (value->>'batch_id') is distinct from (position-1)::text
       or jsonb_typeof(value->'proof') is distinct from 'array' or value->>'leaf_hex' is null) then
    raise exception 'Invalid ordered distribution batch' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(p_batches) b cross join lateral jsonb_array_elements(b->'entries') e
    where e->>'token_account' is null or e->>'token_account' !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
       or e->>'token_owner' is null or e->>'token_owner' !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
       or jsonb_typeof(e->'amount') is distinct from 'string' or e->>'amount' !~ '^[1-9][0-9]{0,19}$') then
    raise exception 'Invalid distribution recipient' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(p_batches) b cross join lateral jsonb_array_elements(b->'entries') e
    where (e->>'amount')::numeric>18446744073709551615) then raise exception 'Distribution amount exceeds u64'; end if;
  select count(*),sum((e->>'amount')::numeric) into n,total
    from jsonb_array_elements(p_batches) b cross join lateral jsonb_array_elements(b->'entries') e;
  if n<>(p_plan->>'entry_count')::integer or batch_n<>(p_plan->>'batch_count')::integer or batch_n<>(n+5)/6
    or total<>(p_plan->>'allocated_amount')::numeric
    or n<>(select count(distinct e->>'token_owner') from jsonb_array_elements(p_batches) b cross join lateral jsonb_array_elements(b->'entries') e)
    or n<>(select count(distinct e->>'token_account') from jsonb_array_elements(p_batches) b cross join lateral jsonb_array_elements(b->'entries') e) then
    raise exception 'Distribution count, total or recipient uniqueness mismatch' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(p_batches) with ordinality b(value,position)
    where position<batch_n and jsonb_array_length(value->'entries')<>6) then
    raise exception 'Distribution batch partition mismatch' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(p_batches) b cross join lateral jsonb_array_elements_text(b->'proof') h where h !~ '^[a-f0-9]{64}$') then
    raise exception 'Invalid distribution proof' using errcode='22023';
  end if;
  insert into public.distribution_plans(network,distribution_pda,distribution_id,share_class,payment_mint,payment_token_program,funder,
    total_amount,snapshot_supply,allocated_amount,root_hex,plan_hash,batch_count,entry_count,created_by)
  values(p_plan->>'network',p_plan->>'distribution_pda',(p_plan->>'distribution_id')::numeric,p_plan->>'share_class',p_plan->>'payment_mint',
    p_plan->>'payment_token_program',p_plan->>'funder',(p_plan->>'total_amount')::numeric,(p_plan->>'snapshot_supply')::numeric,
    total,p_plan->>'root_hex',p_plan->>'plan_hash',batch_n,n,p_plan->>'created_by')
  on conflict(network,distribution_pda) do nothing returning * into result;
  if not found then
    select * into result from public.distribution_plans where network=p_plan->>'network' and distribution_pda=p_plan->>'distribution_pda';
    if result.plan_hash is distinct from p_plan->>'plan_hash' or result.root_hex is distinct from p_plan->>'root_hex'
       or result.funder is distinct from p_plan->>'funder' or result.allocated_amount<>total or result.entry_count<>n or result.batch_count<>batch_n
       or result.total_amount<>(p_plan->>'total_amount')::numeric or result.snapshot_supply<>(p_plan->>'snapshot_supply')::numeric
       or result.share_class is distinct from p_plan->>'share_class' or result.payment_mint is distinct from p_plan->>'payment_mint'
       or result.payment_token_program is distinct from p_plan->>'payment_token_program' or result.distribution_id<>(p_plan->>'distribution_id')::numeric then
      raise exception 'Immutable distribution plan content conflict';
    end if;
    return result.id;
  end if;
  insert into public.distribution_plan_batches(plan_id,batch_id,entries,leaf_hex,proof)
    select result.id,(b->>'batch_id')::integer,b->'entries',b->>'leaf_hex',b->'proof' from jsonb_array_elements(p_batches) b;
  return result.id;
end $$;
create function public.bind_distribution_plan(p_id uuid,p_network text,p_root text,p_hash text,p_slot bigint)
returns void language plpgsql security definer set search_path='' as $$
declare result public.distribution_plans%rowtype;
begin
  select * into result from public.distribution_plans where id=p_id and network=p_network for update;
  if not found or result.root_hex is distinct from p_root or result.plan_hash is distinct from p_hash or p_slot is null or p_slot<0 then
    raise exception 'Distribution binding mismatch' using errcode='22023';
  end if;
  if result.status='bound' then return; end if;
  update public.distribution_plans set status='bound',bound_at=clock_timestamp(),bound_slot=p_slot where id=p_id;
end $$;
revoke all on function public.prepare_distribution_plan(jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.bind_distribution_plan(uuid,text,text,text,bigint) from public,anon,authenticated;
grant execute on function public.prepare_distribution_plan(jsonb,jsonb) to service_role;
grant execute on function public.bind_distribution_plan(uuid,text,text,text,bigint) to service_role;
create view public.distribution_plan_metadata with (security_invoker=true) as
select id,network,distribution_pda,distribution_id::text,share_class,payment_mint,payment_token_program,funder,
  total_amount::text,snapshot_supply::text,allocated_amount::text,root_hex,plan_hash,batch_count,entry_count,created_by,created_at,status,bound_at,bound_slot::text
from public.distribution_plans;
revoke all on public.distribution_plan_metadata from public,anon,authenticated;
grant select on public.distribution_plan_metadata to service_role;
commit;
