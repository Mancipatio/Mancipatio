-- 0038_indexer_composite_key.sql — composite (network, pda) key on indexer tables.
--
-- ============================================================================
-- APPLY WITH the helius-webhook change that upserts onConflict "network,pda".
-- Safe on a single-network deployment; REQUIRED before enabling a second
-- network's indexer against the same Supabase project.
-- ============================================================================
--
-- Every indexer entity table used `pda text primary key` with `network` as a
-- plain column, and the webhook upserted onConflict "pda". PDAs derive from
-- program id + seeds only, so the same issuer/asset/sale account address is
-- identical on devnet and mainnet — a second network's webhook writing into the
-- same project would flip each row's `network` back and forth (devnet lists
-- lose rows when mainnet writes land, and vice versa). Make the key composite
-- (network, pda) so both networks coexist.
--
-- Indexer tables are rebuildable mirrors (the reconcile/webhook repopulate
-- them), so re-keying is safe. Idempotent: only re-keys tables whose PK is not
-- already (network, pda).

do $$
declare
  t text;
  tables text[] := array[
    'platforms', 'issuers', 'assets', 'share_classes', 'sales',
    'custody_vaults', 'offers', 'proposals', 'vote_records',
    'rights_issuances', 'milestones', 'milestone_claims'
  ];
  pk_name text;
  pk_cols text;
begin
  foreach t in array tables loop
    -- Skip tables that don't exist (defensive).
    if not exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
    ) then
      continue;
    end if;

    -- Current primary key column list (ordered).
    select string_agg(a.attname, ',' order by k.ord)
      into pk_cols
    from pg_constraint c
    join lateral unnest(c.conkey) with ordinality as k(attnum, ord) on true
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
    where c.conrelid = format('public.%I', t)::regclass
      and c.contype = 'p';

    -- Already (network, pda) → nothing to do.
    if pk_cols is not distinct from 'network,pda' then
      continue;
    end if;

    -- Drop the existing primary key (whatever its name), add the composite.
    select conname into pk_name
    from pg_constraint
    where conrelid = format('public.%I', t)::regclass and contype = 'p';

    if pk_name is not null then
      execute format('alter table public.%I drop constraint %I', t, pk_name);
    end if;
    execute format('alter table public.%I add primary key (network, pda)', t);
  end loop;
end $$;
