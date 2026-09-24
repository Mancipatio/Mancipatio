-- Retry-worker scheduler: pg_cron calls the site's /api/internal/retry every
-- minute. After migration 0070 (and the identity row); run through db.sh, which
-- asserts the target and passes its site origin:
--   MANCI_TARGET=<t> bash scripts/db.sh -f scripts/ops/retry-scheduler.sql
-- (mainnet also needs MANCI_ALLOW_MAINNET=1). The same SQL serves every
-- project: the network comes from public.deployment_network(), the origin
-- from the target's siteOrigin in scripts/ops/targets.json (a target without
-- one is refused), and both are stored in mancipatio_ops.retry_worker_config.
--
-- Vault must hold exactly one 'mancipatio_retry_worker_<network>' secret, the
-- same worker secret the deployment at that origin has.
-- Installation always DISABLES the job 'mancipatio-retry-<network>' until a
-- live check passes; enable it with
--   select cron.alter_job(jobid, active := true) from cron.job where jobname = 'mancipatio-retry-<network>';
-- Re-running updates the config, the function and the job, and disables the
-- job again. It also upgrades the legacy devnet install in place (same job
-- name; mancipatio_ops.invoke_retry_worker_devnet() is dropped).
-- Synchronous http keeps Authorization in memory; pg_net is not used here.

-- psql does not substitute variables inside $$ bodies: hand the origin to
-- the session first (db.sh set manci.target_network in assert-target.sql).
\o /dev/null
select pg_catalog.set_config('manci.retry_origin', :'target_origin', false);
\o

begin;

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists http with schema extensions;

-- Revoke only privileges owned by this operator. Supabase may instead own
-- extension functions as supabase_admin; never attempt to assume that role.
-- In that case keep extensions outside the Data API and verify it externally.
do $$ declare f record;begin
  for f in
    select p.oid::regprocedure as signature from pg_proc p
    join pg_depend d on d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e'
    join pg_extension e on e.oid=d.refobjid
    where e.extname='http' and p.proowner=current_user::regrole
  loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
  end loop;
end;$$;

do $$
declare
  net text;
  target_network text := current_setting('manci.target_network', true);
  origin text := current_setting('manci.retry_origin', true);
begin
  if to_regclass('public.purchase_evidence_jobs') is null
     or to_regclass('public.indexer_jobs') is null
     or to_regclass('public.distribution_plans') is null then
    raise exception 'Complete the reviewed migrations before installing the worker';
  end if;
  if to_regprocedure('public.deployment_network()') is null then
    raise exception 'Apply migration 0070 and insert the deployment identity before installing the worker';
  end if;
  net := public.deployment_network();
  if target_network is null or target_network = '' then
    raise exception 'Run this file through scripts/db.sh (MANCI_TARGET=<target>)';
  end if;
  if net is distinct from target_network then
    raise exception 'Target mismatch: database is %, target is %', net, target_network;
  end if;
  if origin is null or origin = '-' or origin !~ '^https://[a-z0-9-]+(\.[a-z0-9-]+)+$' then
    raise exception 'The target has no valid siteOrigin (https://<host>, no path) in scripts/ops/targets.json';
  end if;
  if (select count(*) from vault.decrypted_secrets
      where name='mancipatio_retry_worker_'||net
        and length(decrypted_secret)>=32
        and decrypted_secret !~ '[[:space:]]') <> 1 then
    raise exception 'Expected one configured % retry credential in Vault (mancipatio_retry_worker_%)', net, net;
  end if;
end;
$$;

create schema if not exists mancipatio_ops;
revoke all on schema mancipatio_ops from public,anon,authenticated,service_role;
create table if not exists mancipatio_ops.retry_http_runs (
  id bigint generated always as identity primary key,
  requested_at timestamptz not null,
  completed_at timestamptz not null,
  duration_ms integer not null check(duration_ms>=0),
  http_status integer,
  ok boolean not null,
  outcome text not null check(outcome in (
    'complete','http_error','invalid_response','transport_error','timeout','configuration_error'
  )),
  worker_state text check(worker_state in ('busy','processed','partial')),
  indexer_complete integer,indexer_pending integer,indexer_invalid integer,
  purchases_complete integer,purchases_pending integer,purchases_invalid integer
);
alter table mancipatio_ops.retry_http_runs enable row level security;
revoke all on mancipatio_ops.retry_http_runs from public,anon,authenticated,service_role;
revoke all on sequence mancipatio_ops.retry_http_runs_id_seq from public,anon,authenticated,service_role;
create index if not exists retry_http_runs_requested_at_idx
  on mancipatio_ops.retry_http_runs(requested_at);

-- Where the worker lives for this project. One row; the network must agree
-- with the deployment identity (checked again on every invocation).
create table if not exists mancipatio_ops.retry_worker_config (
  singleton boolean primary key default true check (singleton),
  network text not null check (network in ('devnet','mainnet','testnet','localnet')),
  origin text not null check (origin ~ '^https://[a-z0-9-]+(\.[a-z0-9-]+)+$'),
  updated_at timestamptz not null default now(),
  updated_by text not null default current_user
);
alter table mancipatio_ops.retry_worker_config enable row level security;
revoke all on mancipatio_ops.retry_worker_config from public,anon,authenticated,service_role;
insert into mancipatio_ops.retry_worker_config(singleton,network,origin)
values (true,public.deployment_network(),current_setting('manci.retry_origin'))
on conflict (singleton) do update
  set network=excluded.network,origin=excluded.origin,updated_at=now(),updated_by=current_user;

create or replace function mancipatio_ops.invoke_retry_worker()
returns bigint language plpgsql security definer set search_path='' set lock_timeout='3s' as $$
declare
  net text; worker_origin text;
  worker_secret text; result extensions.http_response; payload jsonb;
  started timestamptz:=clock_timestamp(); finished timestamptz; run_id bigint;
  status_code integer; succeeded boolean:=false; result_kind text:='configuration_error';
  worker_state text; counters integer[]:=array[null,null,null,null,null,null]::integer[];
  path text[]; value text; position integer:=1;
begin
  -- Configuration: the identity's network, and an origin stored for it.
  begin
    net:=public.deployment_network();
    select c.origin into strict worker_origin
      from mancipatio_ops.retry_worker_config c where c.network=net;
    if worker_origin !~ '^https://[a-z0-9-]+(\.[a-z0-9-]+)+$' then worker_origin:=null;end if;
  exception when others then net:=null;worker_origin:=null;
  end;
  if net is not null and worker_origin is not null then
    begin
      select decrypted_secret into strict worker_secret
        from vault.decrypted_secrets where name='mancipatio_retry_worker_'||net;
    exception when others then worker_secret:=null;
    end;
  end if;
  if worker_secret is not null and length(worker_secret)>=32 and worker_secret !~ '[[:space:]]' then
    begin
      perform extensions.http_reset_curlopt();
      if not extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS','55000')
         or not extensions.http_set_curlopt('CURLOPT_CONNECTTIMEOUT','5')
         or not extensions.http_set_curlopt('CURLOPT_SSL_VERIFYHOST','2')
         or not extensions.http_set_curlopt('CURLOPT_SSL_VERIFYPEER','1') then
        raise exception 'Required transport settings unavailable';
      end if;
      -- http 1.6's legacy setting can override curl's timeout; pin both.
      perform pg_catalog.set_config('http.timeout_msec','55000',true);
      select * into result from extensions.http((
        'POST',worker_origin||'/api/internal/retry?limit=10',
        array[('Authorization','Bearer '||worker_secret)::extensions.http_header],
        'application/json','{}'
      )::extensions.http_request);
      worker_secret:=null;
      status_code:=result.status;
      result_kind:='http_error';
      if result.status=200 then
        result_kind:='invalid_response';
        begin
          payload:=result.content::jsonb;
          if payload->'ok'='true'::jsonb and payload#>>'{data,network}'=net
             and payload#>>'{data,status}' in ('busy','processed') then
            succeeded:=true;result_kind:='complete';
          end if;
          if payload#>>'{data,status}' in ('busy','processed','partial') then
            worker_state:=payload#>>'{data,status}';
          end if;
          foreach path slice 1 in array array[
            array['data','indexer','counts','complete'],array['data','indexer','counts','pending'],array['data','indexer','counts','invalid'],
            array['data','purchases','counts','complete'],array['data','purchases','counts','pending'],array['data','purchases','counts','invalid']
          ] loop
            value:=payload#>>path;
            if value ~ '^[0-9]{1,9}$' then counters[position]:=value::integer;end if;
            position:=position+1;
          end loop;
        exception when others then succeeded:=false;result_kind:='invalid_response';
        end;
      end if;
    exception
      when query_canceled then result_kind:='timeout';
      when others then result_kind:='transport_error';
    end;
    -- No raw SQLERRM, request headers, response headers or body enter storage.
    worker_secret:=null;payload:=null;result:=null;
    perform extensions.http_reset_curlopt();
  end if;
  finished:=clock_timestamp();
  insert into mancipatio_ops.retry_http_runs(
    requested_at,completed_at,duration_ms,http_status,ok,outcome,worker_state,
    indexer_complete,indexer_pending,indexer_invalid,purchases_complete,purchases_pending,purchases_invalid
  ) values(
    started,finished,greatest(0,(extract(epoch from finished-started)*1000)::integer),
    status_code,succeeded,result_kind,worker_state,counters[1],counters[2],counters[3],counters[4],counters[5],counters[6]
  ) returning id into run_id;
  delete from mancipatio_ops.retry_http_runs where id in (
    select id from mancipatio_ops.retry_http_runs
      where requested_at<now()-interval '7 days' order by requested_at limit 1000
  );
  return run_id;
end;
$$;
revoke all on function mancipatio_ops.invoke_retry_worker()
  from public,anon,authenticated,service_role;

do $$
begin
  if has_schema_privilege('anon','mancipatio_ops','USAGE')
     or has_schema_privilege('authenticated','mancipatio_ops','USAGE')
     or has_function_privilege('anon','mancipatio_ops.invoke_retry_worker()','EXECUTE')
     or has_function_privilege('authenticated','mancipatio_ops.invoke_retry_worker()','EXECUTE')
     or has_table_privilege('anon','mancipatio_ops.retry_http_runs','SELECT')
     or has_table_privilege('authenticated','mancipatio_ops.retry_http_runs','SELECT')
     or has_table_privilege('anon','mancipatio_ops.retry_worker_config','SELECT')
     or has_table_privilege('authenticated','mancipatio_ops.retry_worker_config','SELECT')
     or has_table_privilege('anon','vault.decrypted_secrets','SELECT')
     or has_table_privilege('authenticated','vault.decrypted_secrets','SELECT') then
    raise exception 'Worker operation or Vault is exposed to browser roles';
  end if;
end;
$$;

-- One job per project, named after its network. Scheduling an existing name
-- updates it in place (the legacy devnet job keeps its name and jobid).
select cron.schedule('mancipatio-retry-'||public.deployment_network(),'* * * * *',
  'set statement_timeout=''60s''; select mancipatio_ops.invoke_retry_worker();');
select cron.alter_job(jobid,active:=false)
  from cron.job where jobname='mancipatio-retry-'||public.deployment_network();
drop function if exists mancipatio_ops.invoke_retry_worker_devnet();

select j.jobname, j.active, c.network, c.origin
from cron.job j cross join mancipatio_ops.retry_worker_config c
where j.jobname='mancipatio-retry-'||public.deployment_network();
commit;
