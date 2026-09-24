-- 0070 (Talas 4.3): deployment identity.
--
-- Each Supabase project serves exactly one Solana network. This migration
-- only creates the place that records which one; it changes no behavior and
-- is identical in every project:
--
--   mancipatio_ops.deployment_identity  one row (network, project_ref),
--                                       immutable once inserted
--   public.deployment_network()         that row's network; raises 55000
--                                       while the row is absent
--
-- The row itself is an ops step, once per project, right after this file:
--   MANCI_TARGET=<t> MANCI_DB_BOOTSTRAP=1 bash scripts/db.sh -f scripts/ops/deployment-identity.sql
-- db.sh fills network and project_ref from scripts/ops/targets.json. Nothing
-- reads the function until 0071 (network defaults and guard), which refuses
-- to run without the row.
--
-- EXECUTE is granted to anon, authenticated and service_role (D9): 0071 makes
-- it the default of every `network` column, and a column default runs as the
-- inserting role. The function is SECURITY DEFINER, so none of those roles
-- needs access to the mancipatio_ops schema itself.
--
-- Re-runnable: every statement is idempotent and an existing row is kept.
begin;
set local lock_timeout = '15s';

create schema if not exists mancipatio_ops;
revoke all on schema mancipatio_ops from public, anon, authenticated, service_role;

create table if not exists mancipatio_ops.deployment_identity (
  singleton   boolean primary key default true check (singleton),
  network     text not null check (network in ('devnet', 'mainnet', 'testnet', 'localnet')),
  project_ref text not null check (project_ref ~ '^[a-z0-9]{20}$'),
  created_at  timestamptz not null default now(),
  created_by  text not null default current_user
);
alter table mancipatio_ops.deployment_identity enable row level security;
revoke all on mancipatio_ops.deployment_identity from public, anon, authenticated, service_role;

comment on table mancipatio_ops.deployment_identity is
  'The one Solana network (and Supabase project) this database serves. Inserted once by scripts/ops/deployment-identity.sql; immutable.';

-- Immutable: no UPDATE, DELETE or TRUNCATE, whoever asks. A restore into
-- another project leaves this table's data out and inserts its own row
-- (runbook: restore drill).
create or replace function mancipatio_ops.deployment_identity_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'The deployment identity is immutable'
    using errcode = '55000',
          hint = 'A project keeps its network for life. Restore into a new project instead.';
end;
$$;
revoke all on function mancipatio_ops.deployment_identity_immutable() from public, anon, authenticated, service_role;

drop trigger if exists deployment_identity_immutable on mancipatio_ops.deployment_identity;
create trigger deployment_identity_immutable
  before update or delete on mancipatio_ops.deployment_identity
  for each row execute function mancipatio_ops.deployment_identity_immutable();
drop trigger if exists deployment_identity_no_truncate on mancipatio_ops.deployment_identity;
create trigger deployment_identity_no_truncate
  before truncate on mancipatio_ops.deployment_identity
  for each statement execute function mancipatio_ops.deployment_identity_immutable();

create or replace function public.deployment_network()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  n text;
begin
  select network into n from mancipatio_ops.deployment_identity;
  if n is null then
    raise exception 'Deployment identity is not set' using errcode = '55000';
  end if;
  return n;
end;
$$;
revoke all on function public.deployment_network() from public;
grant execute on function public.deployment_network() to anon, authenticated, service_role;

comment on function public.deployment_network() is
  'The Solana network this project serves (mancipatio_ops.deployment_identity). Raises 55000 until the identity row exists.';

-- PostgREST exposes the new function once its schema cache reloads.
notify pgrst, 'reload schema';

commit;
