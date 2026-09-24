-- Deployment identity row (migration 0070), once per Supabase project.
--
-- Run it right after 0070 and before 0071, through db.sh in bootstrap mode;
-- db.sh fills both variables from scripts/ops/targets.json:
--   MANCI_TARGET=<t> MANCI_DB_BOOTSTRAP=1 bash scripts/db.sh -f scripts/ops/deployment-identity.sql
-- (mainnet also needs MANCI_ALLOW_MAINNET=1).
--
-- The row is immutable. A second run fails on the primary key (and db.sh
-- already refuses bootstrap mode once the row exists).
begin;
insert into mancipatio_ops.deployment_identity (network, project_ref)
values (:'target_network', :'target_ref');
select network, project_ref, created_at, created_by from mancipatio_ops.deployment_identity;
commit;
