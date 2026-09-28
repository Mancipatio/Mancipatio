-- 0079 (8.3, program v1.0.0-rc): the indexer mirror of the pending role
-- changes and the issuer proceeds freezes.
--
-- EXPAND step: six new tables, and apply_indexer_snapshot (0047) replaced by
-- a superset that also writes them. For the 14 existing mirror tables the
-- function body is 0047's, unchanged; the live front never sends the new
-- tables, so it is safe with the front that is live when this is applied.
-- Apply it BEFORE the v1.0.0-rc front: until then the snapshot function
-- refuses a row of a new table ("Invalid typed indexer row"), so the job of
-- any transaction that touched one stays pending (indexer degraded).
--
--  1. The tables, one per program account type (lib/server/indexer-accounts.ts
--     ROLE_STATE_ENTITIES; generated decoders, PDAs re-derived with the
--     generated helpers):
--       issuer_freezes                 asset_registry IssuerFreeze        ["issuer_freeze", issuer]
--       pending_admins                 asset_registry PendingAdmin        ["pending_admin", new_admin]
--       authority_proposals            asset_registry AuthorityProposal   ["authority_proposal", target]
--       platform_recoveries            asset_registry PlatformRecovery    ["platform_recovery", platform]
--       blocklist_authority_proposals  transfer_hook BlocklistAuthorityProposal ["blocklist_authority_proposal"]
--       blocklist_recoveries           transfer_hook BlocklistRecovery    ["blocklist_recovery"]
--     Timestamps are i64 unix seconds. A row lives while its account does:
--     execute, accept and cancel close the account and the snapshot deletes
--     the row. The rc.x AuthorityTransfer / BlocklistAuthorityTransfer are
--     not mirrored (lib/legacy-accounts.ts; the reconcile reports them).
--  2. Every new table is service_role only: RLS on, browser roles revoked.
--     The readers are the admin menu badges (POST /api/admin/badges) and the
--     alarm worker's role-change-pending check, both with the service key;
--     the pages read the chain.
--  3. The stale-slot trigger of 0047 on each table, and the 0071 network
--     guard (rules for migrations after 0071: dynamic default, guards
--     reinstalled, no literal network seeded).
--  4. apply_indexer_snapshot: its table list grows by the six tables.
--
-- The freshness heartbeat (0075) samples every mirrored account but compares
-- only its 14 tables (confirm_indexer_quiet's mirror_tables), so a sampled
-- role-state row is skipped, never a mismatch: the hook owns two of them.
--
-- Rollback (not a migration): re-run 0047's apply_indexer_snapshot (the
-- 14-table list) and drop the six tables. The v1.0.0-rc front must not run
-- against a database without them (its jobs would stay pending).
--
-- Re-runnable: every statement is idempotent.
begin;
set local lock_timeout = '15s';

do $$
begin
  if to_regprocedure('public.apply_indexer_snapshot(text,bigint,jsonb,text[],text,integer)') is null
     or to_regprocedure('public.indexer_reject_stale_slot()') is null
     or to_regclass('public.indexer_account_versions') is null
     or to_regprocedure('public.deployment_network()') is null
     or to_regprocedure('mancipatio_ops.install_network_guards()') is null then
    raise exception 'Apply 0047 and 0070-0071 before 0079';
  end if;
end;
$$;

-- ── 1. Tables ───────────────────────────────────────────────────────────────
create table if not exists public.issuer_freezes (
  network         text not null default public.deployment_network()
                    check (network in ('mainnet', 'devnet', 'testnet', 'localnet')),
  pda             text not null,
  issuer_pda      text not null,
  frozen_by       text not null,
  frozen_at       bigint not null,
  reason_hash     text not null check (reason_hash ~ '^[0-9a-f]{64}$'),
  account_version integer,
  layout_version  integer,
  raw             jsonb not null default '{}'::jsonb,
  last_signature  text,
  last_slot       bigint,
  updated_at      timestamptz not null default now(),
  primary key (network, pda)
);
comment on table public.issuer_freezes is
  'Indexer mirror (0079) of asset_registry IssuerFreeze ["issuer_freeze", issuer]: the issuer''s proceeds are frozen while the row exists (D1). service_role only.';

create table if not exists public.pending_admins (
  network         text not null default public.deployment_network()
                    check (network in ('mainnet', 'devnet', 'testnet', 'localnet')),
  pda             text not null,
  new_admin       text not null,
  proposed_by     text not null,
  proposed_at     bigint not null,
  eta             bigint not null,
  expires_at      bigint not null,
  account_version integer,
  layout_version  integer,
  raw             jsonb not null default '{}'::jsonb,
  last_signature  text,
  last_slot       bigint,
  updated_at      timestamptz not null default now(),
  primary key (network, pda)
);
comment on table public.pending_admins is
  'Indexer mirror (0079) of asset_registry PendingAdmin ["pending_admin", new_admin]: a staged Admin grant, executable by the new key inside [eta, expires_at) (D3). service_role only.';

create table if not exists public.authority_proposals (
  network           text not null default public.deployment_network()
                      check (network in ('mainnet', 'devnet', 'testnet', 'localnet')),
  pda               text not null,
  target            text not null,
  -- 0 platform (super admin), 1 custody vault, 2 issuer, 3 KYC registry.
  kind              integer not null check (kind between 0 and 255),
  current_authority text not null,
  new_authority     text not null,
  proposed_by       text not null,
  proposed_at       bigint not null,
  eta               bigint not null,
  expires_at        bigint not null,
  account_version   integer,
  layout_version    integer,
  raw               jsonb not null default '{}'::jsonb,
  last_signature    text,
  last_slot         bigint,
  updated_at        timestamptz not null default now(),
  primary key (network, pda)
);
comment on table public.authority_proposals is
  'Indexer mirror (0079) of asset_registry AuthorityProposal ["authority_proposal", target]: a staged rotation, acceptable inside [eta, expires_at). service_role only.';

create table if not exists public.platform_recoveries (
  network         text not null default public.deployment_network()
                    check (network in ('mainnet', 'devnet', 'testnet', 'localnet')),
  pda             text not null,
  platform_pda    text not null,
  current_admin   text not null,
  new_admin       text not null,
  proposed_by     text not null,
  proposed_at     bigint not null,
  eta             bigint not null,
  expires_at      bigint not null,
  account_version integer,
  layout_version  integer,
  raw             jsonb not null default '{}'::jsonb,
  last_signature  text,
  last_slot       bigint,
  updated_at      timestamptz not null default now(),
  primary key (network, pda)
);
comment on table public.platform_recoveries is
  'Indexer mirror (0079) of asset_registry PlatformRecovery ["platform_recovery", platform]: the upgrade authority''s super-admin recovery, executable by the new key from eta (D4). service_role only.';

create table if not exists public.blocklist_authority_proposals (
  network           text not null default public.deployment_network()
                      check (network in ('mainnet', 'devnet', 'testnet', 'localnet')),
  pda               text not null,
  current_authority text not null,
  new_authority     text not null,
  proposed_at       bigint not null,
  expires_at        bigint not null,
  account_version   integer,
  layout_version    integer,
  raw               jsonb not null default '{}'::jsonb,
  last_signature    text,
  last_slot         bigint,
  updated_at        timestamptz not null default now(),
  primary key (network, pda)
);
comment on table public.blocklist_authority_proposals is
  'Indexer mirror (0079) of transfer_hook BlocklistAuthorityProposal ["blocklist_authority_proposal"]: a staged blocklist-authority rotation (no timelock, 14 days to accept). service_role only.';

create table if not exists public.blocklist_recoveries (
  network           text not null default public.deployment_network()
                      check (network in ('mainnet', 'devnet', 'testnet', 'localnet')),
  pda               text not null,
  current_authority text not null,
  new_authority     text not null,
  proposed_by       text not null,
  proposed_at       bigint not null,
  eta               bigint not null,
  expires_at        bigint not null,
  account_version   integer,
  layout_version    integer,
  raw               jsonb not null default '{}'::jsonb,
  last_signature    text,
  last_slot         bigint,
  updated_at        timestamptz not null default now(),
  primary key (network, pda)
);
comment on table public.blocklist_recoveries is
  'Indexer mirror (0079) of transfer_hook BlocklistRecovery ["blocklist_recovery"]: the upgrade authority''s blocklist-authority recovery, executable by the new key from eta (D4). service_role only.';

-- ── 2. Access, 3. stale-slot trigger ────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['issuer_freezes', 'pending_admins', 'authority_proposals', 'platform_recoveries',
                           'blocklist_authority_proposals', 'blocklist_recoveries'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('drop trigger if exists %I on public.%I', t || '_reject_stale_slot', t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function public.indexer_reject_stale_slot()',
      t || '_reject_stale_slot', t);
  end loop;
end;
$$;

-- ── 4. The snapshot writer: 0047's body with six more tables ────────────────
-- Snapshot updates AND deletions serialize on each network/PDA. A tombstone
-- keeps an older in-flight snapshot from resurrecting a closed account.
create or replace function public.apply_indexer_snapshot(p_network text,p_slot bigint,p_rows jsonb,p_closed text[],p_signature text,p_layout_version integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  item jsonb; payload jsonb; target text; addr text; t text; cols text; updates text;
  known public.indexer_account_versions%rowtype; changed integer; written integer:=0; removed integer:=0; stale integer:=0;
  applied jsonb:='[]'; deleted jsonb:='{}';
  tables text[]:=array['platforms','issuers','assets','share_classes','sales','custody_vaults','offers','proposals','vote_records','rights_issuances','milestones','milestone_claims','kyc_registries','kyc_entries',
    -- 0079 (v1.0.0-rc role state)
    'issuer_freezes','pending_admins','authority_proposals','platform_recoveries','blocklist_authority_proposals','blocklist_recoveries'];
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
revoke all on function public.apply_indexer_snapshot(text,bigint,jsonb,text[],text,integer) from public,anon,authenticated;
grant execute on function public.apply_indexer_snapshot(text,bigint,jsonb,text[],text,integer) to service_role;

select mancipatio_ops.install_network_guards();

commit;
