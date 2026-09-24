-- 0071 (Talas 4.3): network defaults from the deployment identity, and a
-- guard that keeps each project to its own network.
--
-- Needs 0070 AND the identity row (scripts/ops/deployment-identity.sql); the
-- first block refuses otherwise.
--
-- 1. Defaults. Every `network` column that defaulted to the literal 'devnet'
--    (33 columns, found by grepping `default 'devnet'`; none was dropped
--    later) now defaults to public.deployment_network(). On the devnet
--    project that is still 'devnet', so today's front, which sets network
--    explicitly or relies on the default, behaves exactly as before. No
--    insert needs to change.
--
-- 2. Guard (D8, asymmetric). A BEFORE INSERT OR UPDATE OF network row trigger,
--    manci_network_guard, on every public table with a `network` column:
--      - a mainnet project accepts only network = 'mainnet';
--      - any other project never accepts 'mainnet' (a testnet front may still
--        write 'testnet' rows into the devnet project).
--    mancipatio_ops.install_network_guards() (re)installs it on every such
--    table and is idempotent. Rows already stored under another network stay
--    as they are (e.g. 0056's 'mainnet' raise-limit row on devnet); the
--    trigger fires only on INSERT and on UPDATE OF network.
--
--    Side effects, all intended: with a wrong INDEXER_NETWORK the edge
--    function's enqueue_indexer_events raises and the webhook answers 503
--    (Helius retries) instead of filing events under the wrong network;
--    acquire_retry_worker_lease raises, so /api/internal/retry answers 503;
--    `maintenance.sh mainnet on` against the devnet database is refused.
--
-- RULES for every migration after 0071 (tests/migration-chain.postgres.test.ts
-- enforces them, including a full chain run under a mainnet identity):
--   1. A new `network` column uses `default public.deployment_network()` or no
--      default. Never a literal.
--   2. A migration that adds a `network` column ends with
--      `select mancipatio_ops.install_network_guards();`.
--   3. Never seed rows with a literal network. Use public.deployment_network()
--      (e.g. `insert ... values (public.deployment_network())`); a literal
--      fails on the other project.
--
-- Rollback (not a migration): scripts/ops/rollback-0071.sql drops the guard
-- (defaults stay dynamic, 0070 stays); scripts/ops/rollback-0071-defaults.sql
-- pins the defaults to this project's own network literal.
--
-- Re-runnable: re-applying re-sets the same defaults and reinstalls the guard.
begin;
set local lock_timeout = '15s';

do $$
begin
  if to_regprocedure('public.deployment_network()') is null
     or to_regclass('mancipatio_ops.deployment_identity') is null then
    raise exception 'Apply 0070 and insert the deployment identity (scripts/ops/deployment-identity.sql) before 0071';
  end if;
  if not exists (select 1 from mancipatio_ops.deployment_identity) then
    raise exception 'Insert the deployment identity (scripts/ops/deployment-identity.sql) before 0071';
  end if;
end;
$$;

-- 1. Defaults (0001, 0002, 0003, 0004, 0005, 0014, 0015, 0018, 0020, 0022,
--    0023, 0024, 0034, 0040, 0043, 0045, 0049).
alter table public.audit_events         alter column network set default public.deployment_network();
alter table public.platforms            alter column network set default public.deployment_network();
alter table public.issuers              alter column network set default public.deployment_network();
alter table public.assets               alter column network set default public.deployment_network();
alter table public.share_classes        alter column network set default public.deployment_network();
alter table public.sales                alter column network set default public.deployment_network();
alter table public.custody_vaults       alter column network set default public.deployment_network();
alter table public.offers               alter column network set default public.deployment_network();
alter table public.proposals            alter column network set default public.deployment_network();
alter table public.vote_records         alter column network set default public.deployment_network();
alter table public.rights_issuances     alter column network set default public.deployment_network();
alter table public.milestones           alter column network set default public.deployment_network();
alter table public.milestone_claims     alter column network set default public.deployment_network();
alter table public.indexer_events       alter column network set default public.deployment_network();
alter table public.clients              alter column network set default public.deployment_network();
alter table public.fee_config           alter column network set default public.deployment_network();
alter table public.fee_waivers          alter column network set default public.deployment_network();
alter table public.compliance_alerts    alter column network set default public.deployment_network();
alter table public.asset_profiles       alter column network set default public.deployment_network();
alter table public.issuer_profiles      alter column network set default public.deployment_network();
alter table public.spvs                 alter column network set default public.deployment_network();
alter table public.delivery_requests    alter column network set default public.deployment_network();
alter table public.resell_listings      alter column network set default public.deployment_network();
alter table public.custom_inquiries     alter column network set default public.deployment_network();
alter table public.otc_requests         alter column network set default public.deployment_network();
alter table public.conversion_requests  alter column network set default public.deployment_network();
alter table public.kyc_registries       alter column network set default public.deployment_network();
alter table public.kyc_entries          alter column network set default public.deployment_network();
alter table public.vesting_series       alter column network set default public.deployment_network();
alter table public.commitments          alter column network set default public.deployment_network();
alter table public.launch_applications  alter column network set default public.deployment_network();
alter table public.launch_listings      alter column network set default public.deployment_network();
alter table public.launch_updates       alter column network set default public.deployment_network();

-- 2. Guard.
create or replace function mancipatio_ops.enforce_deployment_network()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  deployed text := public.deployment_network();
begin
  if (deployed = 'mainnet') is distinct from (new.network = 'mainnet') then
    raise exception 'network % does not belong to this % project', new.network, deployed
      using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function mancipatio_ops.enforce_deployment_network() from public, anon, authenticated, service_role;

-- Installs manci_network_guard on every public table (relkind r/p, not a
-- partition: a partition inherits its parent's trigger) with a `network`
-- column. Idempotent; returns the number of tables guarded. Runs as its
-- caller (the migration owner), never from the Data API.
create or replace function mancipatio_ops.install_network_guards()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  t record;
  installed integer := 0;
begin
  for t in
    select c.oid::regclass as rel
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid = c.oid
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not c.relispartition
      and a.attname = 'network'
      and a.attnum > 0
      and not a.attisdropped
    order by c.relname
  loop
    execute format('drop trigger if exists manci_network_guard on %s', t.rel);
    execute format(
      'create trigger manci_network_guard before insert or update of network on %s '
      'for each row execute function mancipatio_ops.enforce_deployment_network()', t.rel);
    installed := installed + 1;
  end loop;
  return installed;
end;
$$;
revoke all on function mancipatio_ops.install_network_guards() from public, anon, authenticated, service_role;

select mancipatio_ops.install_network_guards();

commit;
