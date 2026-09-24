-- Read-only: deployment identity (0070), network defaults and guard (0071),
-- retry worker configuration. Counts and names only, no row contents.
--   MANCI_TARGET=<t> bash scripts/db.sh -f scripts/preflight/supabase-readonly-identity.sql
-- Works on a project without 0070 or without the identity row too (it reports
-- them as null), so it can run before, between and after the rollout steps.
--
--   identity                          the identity row, or null
--   rows_of_other_networks            per table, rows whose network differs from
--                                     the identity, and how many of them the
--                                     guard would refuse on insert (existing
--                                     rows stay; see 0071)
--   tables_without_guard              network tables lacking manci_network_guard
--   defaults_not_dynamic              network defaults other than
--                                     deployment_network() (none = no default)
--   browser_insert_paths              network tables anon/authenticated could
--                                     insert into (privilege AND no RLS or an
--                                     INSERT/ALL policy for them): G5
--   retry_worker_config               the scheduler's network and origin, or null
begin read only;
set local statement_timeout = '60s';
with ident as (
  select case when to_regclass('mancipatio_ops.deployment_identity') is null then null
    -- An empty table gives an empty document: nullif keeps that a null.
    else (xpath('/row/j/text()', nullif(query_to_xml(
      'select to_jsonb(i)::text as j from mancipatio_ops.deployment_identity i', false, true, '')::text, '')::xml))[1]::text::jsonb
  end as row
), net as (
  select (select row->>'network' from ident) as network
), network_tables as (
  select c.oid, c.relname, c.relrowsecurity, pg_get_expr(d.adbin, d.adrelid) as default_expr
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
    and a.attname = 'network' and a.attnum > 0 and not a.attisdropped
), counts as (
  select t.relname, x.counted
  from network_tables t
  cross join net
  cross join lateral (
    select query_to_xml(format(
      'select count(*) filter (where network is distinct from %1$L) as other, '
      || 'count(*) filter (where (%1$L = ''mainnet'') is distinct from (network = ''mainnet'')) as refused '
      || 'from public.%2$I', net.network, t.relname), false, true, '') as counted
  ) x
  where net.network is not null
)
select jsonb_build_object(
  'checked_at', clock_timestamp(),
  'identity', (select row from ident),
  'deployment_network_function', to_regprocedure('public.deployment_network()') is not null,
  'network_tables', (select count(*) from network_tables),
  'rows_of_other_networks', (
    select coalesce(jsonb_object_agg(relname, jsonb_build_object('other_network', other, 'guard_would_refuse', refused)), '{}'::jsonb)
    from (
      select relname,
        (xpath('/row/other/text()', counted))[1]::text::bigint as other,
        (xpath('/row/refused/text()', counted))[1]::text::bigint as refused
      from counts
    ) c
    where other > 0
  ),
  'tables_without_guard', (
    select coalesce(jsonb_agg(relname order by relname), '[]'::jsonb) from network_tables t
    where not exists (
      select 1 from pg_trigger g
      where g.tgrelid = t.oid and g.tgname = 'manci_network_guard' and not g.tgisinternal)
  ),
  'defaults_not_dynamic', (
    select coalesce(jsonb_object_agg(relname, default_expr), '{}'::jsonb) from network_tables
    where default_expr is not null and default_expr !~ '^(public\.)?deployment_network\(\)$'
  ),
  'browser_insert_paths', (
    select coalesce(jsonb_agg(relname order by relname), '[]'::jsonb) from network_tables t
    where (has_table_privilege('anon', t.oid, 'INSERT') or has_table_privilege('authenticated', t.oid, 'INSERT'))
      and (not t.relrowsecurity or exists (
        select 1 from pg_policies p
        where p.schemaname = 'public' and p.tablename = t.relname and p.cmd in ('INSERT', 'ALL')
          and p.roles && array['public', 'anon', 'authenticated']::name[]))
  ),
  'retry_worker_config', case when to_regclass('mancipatio_ops.retry_worker_config') is null then null
    else (xpath('/row/j/text()', nullif(query_to_xml(
      'select jsonb_build_object(''network'', network, ''origin'', origin, ''updated_at'', updated_at)::text as j from mancipatio_ops.retry_worker_config',
      false, true, '')::text, '')::xml))[1]::text::jsonb
  end
) as preflight;
rollback;
