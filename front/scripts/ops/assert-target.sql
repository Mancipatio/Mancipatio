-- Target assertion. scripts/db.sh (and backup.sh) run this file FIRST in the
-- same psql session, with ON_ERROR_STOP, before any caller -f / -c:
--   psql -v ON_ERROR_STOP=1 -v target_network=… -v target_ref=… -v target_origin=…
--        -v bootstrap=0|1 -f scripts/ops/assert-target.sql <caller files>
-- A failure here stops psql before the caller's SQL runs.
--
-- It also leaves session settings for the files that follow (they must run
-- via -f in the same session): manci.target_network, manci.target_ref,
-- manci.bootstrap.
--
-- Identity row present:  bootstrap=1 is refused, and network AND project ref
--                        must equal the target.
-- Identity absent:       refused unless bootstrap=1 (MANCI_DB_BOOTSTRAP=1),
--                        which is only for the steps before and including the
--                        identity insert on a new project.
\o /dev/null
select pg_catalog.set_config('manci.target_network', :'target_network', false),
       pg_catalog.set_config('manci.target_ref', :'target_ref', false),
       pg_catalog.set_config('manci.bootstrap', :'bootstrap', false);
\o

do $$
declare
  want_network text := current_setting('manci.target_network');
  want_ref text := current_setting('manci.target_ref');
  bootstrap boolean := current_setting('manci.bootstrap') = '1';
  have_network text;
  have_ref text;
begin
  if to_regclass('mancipatio_ops.deployment_identity') is not null then
    execute 'select network, project_ref from mancipatio_ops.deployment_identity'
      into have_network, have_ref;
  end if;
  if have_network is not null then
    if bootstrap then
      raise exception 'Bootstrap refused: the identity is already set; unset MANCI_DB_BOOTSTRAP';
    end if;
    if have_network is distinct from want_network or have_ref is distinct from want_ref then
      raise exception 'Target mismatch: database is % (%)', have_network, have_ref;
    end if;
  elsif bootstrap then
    raise notice 'BOOTSTRAP MODE: no identity to verify';
  else
    raise exception 'No deployment identity in this database: apply 0070 and insert it (scripts/ops/deployment-identity.sql) with MANCI_DB_BOOTSTRAP=1';
  end if;
end;
$$;
