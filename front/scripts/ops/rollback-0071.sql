-- Rollback level 1 for migration 0071 (the standard one): remove the network
-- guard. Not a migration; back up first (backup.sh <target> pre-rollback-0071).
--   MANCI_TARGET=<t> bash scripts/db.sh -f scripts/ops/rollback-0071.sql
--
-- Drops every manci_network_guard trigger, enforce_deployment_network() and
-- install_network_guards(). Column defaults are left alone: they still
-- resolve through public.deployment_network(), which 0070 keeps, so they stay
-- correct on either project. Refuses without the identity row.
-- Re-applying 0071 later reinstalls the guard.
begin;
set local lock_timeout = '15s';

do $$
declare
  t record;
begin
  if to_regclass('mancipatio_ops.deployment_identity') is null then
    raise exception 'Rollback refused: the deployment identity (0070) is missing';
  end if;
  if not exists (select 1 from mancipatio_ops.deployment_identity) then
    raise exception 'Rollback refused: the deployment identity is not set';
  end if;
  for t in
    select tg.tgrelid::regclass as rel
    from pg_catalog.pg_trigger tg
    where tg.tgname = 'manci_network_guard'
      and not tg.tgisinternal
      and tg.tgparentid = 0
  loop
    execute format('drop trigger if exists manci_network_guard on %s', t.rel);
  end loop;
end;
$$;

drop function if exists mancipatio_ops.install_network_guards();
drop function if exists mancipatio_ops.enforce_deployment_network();

select count(*) as remaining_guards from pg_catalog.pg_trigger where tgname = 'manci_network_guard';
commit;
