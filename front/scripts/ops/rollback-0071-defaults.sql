-- Rollback level 2 for migration 0071: ONLY if public.deployment_network()
-- itself is the problem as a column default. Run level 1
-- (rollback-0071.sql) first; back up before either.
--   MANCI_TARGET=<t> bash scripts/db.sh -f scripts/ops/rollback-0071-defaults.sql
--
-- Every public `network` column whose default calls deployment_network() (the
-- 33 set by 0071, and any later column that follows the migration rules) gets
-- this project's OWN network as a literal default: 'mainnet' on the mainnet
-- project, 'devnet' on devnet. Never a hardcoded 'devnet'. Refuses without
-- the identity row. Re-applying 0071 restores the dynamic defaults.
begin;
set local lock_timeout = '15s';

do $$
declare
  deployed text;
  t record;
begin
  if to_regclass('mancipatio_ops.deployment_identity') is null then
    raise exception 'Rollback refused: the deployment identity (0070) is missing';
  end if;
  if not exists (select 1 from mancipatio_ops.deployment_identity) then
    raise exception 'Rollback refused: the deployment identity is not set';
  end if;
  deployed := public.deployment_network();
  for t in
    select c.relname
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and a.attname = 'network'
      and a.attnum > 0
      and not a.attisdropped
      and pg_catalog.pg_get_expr(d.adbin, d.adrelid) ~ 'deployment_network\(\)'
    order by c.relname
  loop
    execute format('alter table public.%I alter column network set default %L', t.relname, deployed);
  end loop;
end;
$$;

select count(*) as literal_defaults
from pg_catalog.pg_attribute a
join pg_catalog.pg_class c on c.oid = a.attrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
where n.nspname = 'public' and a.attname = 'network'
  and pg_catalog.pg_get_expr(d.adbin, d.adrelid) = pg_catalog.quote_literal(public.deployment_network()) || '::text';
commit;
