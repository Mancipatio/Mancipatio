-- Apply before the new evidence APIs. Historical rows remain unverified and
-- excluded from confirmed totals until reconciled; no history is discarded.
begin;
alter table public.commitments
  add column if not exists network text not null default 'devnet',
  add column if not exists evidence_verified boolean not null default false,
  add column if not exists payment_mint text,
  add column if not exists payment_decimals integer,
  add column if not exists amount_atomic numeric(20,0),
  add column if not exists units numeric(20,0),
  add column if not exists instruction_index integer,
  add column if not exists finalized_slot numeric(20,0);
alter table public.commitments add constraint commitments_verified_evidence check (
  not evidence_verified or (status = 'settled' and settled_tx is not null
    and payment_mint is not null and payment_decimals is not null and payment_decimals between 0 and 18
    and amount_atomic is not null and amount_atomic > 0 and units is not null and units > 0
    and instruction_index is not null and instruction_index >= 0 and finalized_slot is not null and finalized_slot >= 0
    and amount = amount_atomic / power(10::numeric,payment_decimals))
);
drop index if exists public.commitments_settled_tx_key;
create unique index commitments_verified_instruction_key
  on public.commitments(network, settled_tx, instruction_index) where evidence_verified;
create index commitments_network_sale_idx on public.commitments(network, sale_pubkey);
-- Preflight deliberately fails on ambiguous historical active pledges. Resolve
-- their intended amounts explicitly; migration must not silently discard rights.
create unique index commitments_active_pledge_key
  on public.commitments(network,sale_pubkey,investor_wallet) where status in ('pending','confirmed');
create function public.record_soft_commitment(p_network text,p_sale text,p_wallet text,p_amount numeric)
returns uuid language plpgsql set search_path='' as $$
declare existing public.commitments%rowtype; result uuid;
begin
  if p_network not in ('devnet','mainnet','testnet','localnet') or p_amount is null or p_amount <= 0 then
    raise exception 'invalid commitment terms';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_network || ':' || p_sale || ':' || p_wallet,0));
  select * into existing from public.commitments where network=p_network and sale_pubkey=p_sale
    and investor_wallet=p_wallet and status in ('pending','confirmed') for update;
  if found then
    if existing.amount is distinct from p_amount then
      raise exception 'an active pledge with different terms already exists' using errcode='23505';
    end if;
    return existing.id;
  end if;
  insert into public.commitments(network,sale_pubkey,investor_wallet,amount,status)
    values(p_network,p_sale,p_wallet,p_amount,'pending') returning id into result;
  return result;
end;
$$;
revoke all on function public.record_soft_commitment(text,text,text,numeric) from public,anon,authenticated;
grant execute on function public.record_soft_commitment(text,text,text,numeric) to service_role;
grant select,insert,update on public.commitments to service_role;
create function public.immutable_verified_purchase() returns trigger language plpgsql set search_path='' as $$
begin
  if old.evidence_verified and new is distinct from old then raise exception 'verified purchase evidence is immutable';end if;
  return new;
end;
$$;
create trigger commitments_verified_immutable before update on public.commitments for each row execute function public.immutable_verified_purchase();
create table public.purchase_evidence_jobs (
  id uuid primary key default gen_random_uuid(), network text not null, buyer text not null,
  sale_pubkey text not null, signature text not null,
  requested_instruction integer not null default -1 check (requested_instruction >= -1),
  status text not null default 'pending' check (status in ('pending','complete','invalid')),
  attempts integer not null default 0, next_attempt_at timestamptz not null default now(),
  last_error text, commitment_id uuid references public.commitments(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(network,signature,buyer,sale_pubkey,requested_instruction)
);
alter table public.purchase_evidence_jobs enable row level security;
revoke all on public.purchase_evidence_jobs from anon, authenticated;
grant all on public.purchase_evidence_jobs to service_role;
create index purchase_evidence_jobs_pending_idx on public.purchase_evidence_jobs(network,next_attempt_at) where status='pending';
alter table public.delivery_requests add column if not exists deposit_evidence jsonb,add column if not exists outcome_evidence jsonb;
alter table public.conversion_requests add column if not exists deposit_evidence jsonb,add column if not exists outcome_evidence jsonb;
create table public.custody_request_bindings (
  network text not null, vault_pda text not null,
  request_table text not null check (request_table in ('delivery_requests','conversion_requests')),
  request_id uuid not null, primary key(network,vault_pda), unique(request_table,request_id)
);
alter table public.custody_request_bindings enable row level security;
revoke all on public.custody_request_bindings from anon, authenticated;
grant all on public.custody_request_bindings to service_role;
-- Seed every existing linkage. A vault reused by historical requests aborts
-- this migration through the primary key instead of blessing the first caller.
insert into public.custody_request_bindings(network,vault_pda,request_table,request_id)
select network,vault_pda,'delivery_requests',id from public.delivery_requests where vault_pda is not null
union all select network,vault_pda,'conversion_requests',id from public.conversion_requests where vault_pda is not null;
create function public.guard_custody_evidence() returns trigger language plpgsql set search_path='' as $$
begin
  if old.vault_pda is not null and (new.vault_pda is distinct from old.vault_pda or new.network is distinct from old.network
    or new.holder_wallet is distinct from old.holder_wallet or new.mint is distinct from old.mint
    or new.share_class_pda is distinct from old.share_class_pda or new.amount is distinct from old.amount
    or new.vault_id is distinct from old.vault_id) then
    raise exception 'linked custody request terms are immutable';
  end if;
  if old.deposit_evidence is not null and (new.deposit_evidence is distinct from old.deposit_evidence
    or new.deposit_tx is distinct from old.deposit_tx) then
    raise exception 'verified deposit evidence is immutable';
  end if;
  if old.outcome_evidence is not null and (new.outcome_evidence is distinct from old.outcome_evidence
    or new.outcome_tx is distinct from old.outcome_tx) then
    raise exception 'verified outcome evidence is immutable';
  end if;
  if new.vault_pda is not null then
    insert into public.custody_request_bindings(network,vault_pda,request_table,request_id)
    values(new.network,new.vault_pda,tg_table_name,new.id) on conflict(network,vault_pda) do nothing;
    if not exists(select 1 from public.custody_request_bindings b where b.network=new.network
      and b.vault_pda=new.vault_pda and b.request_table=tg_table_name and b.request_id=new.id) then
      raise exception 'vault already belongs to another request';
    end if;
  end if;
  if new.status='deposited' and old.status is distinct from 'deposited'
    and (new.deposit_tx is null or new.deposit_evidence is null
      or new.deposit_evidence->>'signature' is distinct from new.deposit_tx
      or new.deposit_evidence->>'vault' is distinct from new.vault_pda
      or (new.deposit_evidence->>'amountAtomic')::numeric is distinct from new.amount) then
    raise exception 'verified deposit evidence is required';
  end if;
  -- The deposit DB acknowledgement can be lost before a valid holder exit or
  -- realization. Permit terminal recovery only with server-verified evidence
  -- of the actual transfer or burn, including any unrelated escrow surplus.
  if new.status in ('returned','delivered','converted') and (
    new.vault_pda is null or new.outcome_tx is null or new.outcome_evidence is null
    or new.outcome_evidence->>'signature' is distinct from new.outcome_tx
    or new.outcome_evidence->>'vault' is distinct from new.vault_pda
    or coalesce((new.outcome_evidence->>'amountAtomic')::numeric,0) < new.amount
    or new.amount <= 0
    or coalesce((new.outcome_evidence->>'slot')::numeric,-1) < 0
    or coalesce((new.outcome_evidence->>'instructionIndex')::integer,-1) < 0
  ) then
    raise exception 'verified outcome evidence is required';
  end if;
  return new;
end;
$$;
create trigger delivery_evidence_guard before update on public.delivery_requests for each row execute function public.guard_custody_evidence();
create trigger conversion_evidence_guard before update on public.conversion_requests for each row execute function public.guard_custody_evidence();
-- Override the old 0030/0034 matrices. A failed deposit acknowledgement must
-- not permanently prevent recording a later finalized outcome. The evidence
-- trigger above remains mandatory, and terminal states remain immutable.
create or replace function public.delivery_requests_guard_status()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.status is distinct from old.status and not (
    (old.status in ('requested','approved') and new.status in ('vault_opened','cancelled')) or
    (old.status='vault_opened' and new.status in ('deposited','cancelled','returned','delivered')) or
    (old.status='deposited' and new.status in ('in_delivery','delivered','returned')) or
    (old.status='in_delivery' and new.status in ('delivered','returned'))
  ) then
    raise exception 'illegal delivery status transition: % -> %',old.status,new.status;
  end if;
  return new;
end;
$$;
create or replace function public.conversion_requests_guard_status()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.status is distinct from old.status and not (
    (old.status in ('requested','approved') and new.status in ('vault_opened','cancelled')) or
    (old.status='vault_opened' and new.status in ('deposited','cancelled','returned','converted')) or
    (old.status='deposited' and new.status in ('converted','returned'))
  ) then
    raise exception 'illegal conversion status transition: % -> %',old.status,new.status;
  end if;
  return new;
end;
$$;
-- PostgreSQL aggregation avoids REST row limits. Token units are not USD.
create function public.commitment_totals(p_network text,p_sale text) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object(
    'pledged',coalesce(sum(amount) filter(where status='pending'),0)::text,
    'confirmed',coalesce(sum(amount) filter(where status='confirmed'),0)::text,
    'settled',coalesce(sum(amount) filter(where status='settled' and evidence_verified),0)::text,
    'backers',count(distinct investor_wallet) filter(where status='settled' and evidence_verified),
    'pledgers',count(distinct investor_wallet) filter(where status in ('pending','confirmed')),
    'paymentMint',min(payment_mint) filter(where status='settled' and evidence_verified),
    'unverified',count(*) filter(where status='settled' and not evidence_verified)
  ) from public.commitments where network=p_network and sale_pubkey=p_sale;
$$;
revoke all on function public.commitment_totals(text,text) from public,anon,authenticated;
grant execute on function public.commitment_totals(text,text) to service_role;
commit;
