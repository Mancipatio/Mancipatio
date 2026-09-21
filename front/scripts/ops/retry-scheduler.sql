-- Reviewed devnet only, after migrations 0044–0051 and matching Vercel deploy.
-- Vault must contain mancipatio_retry_worker_devnet with the same worker secret.
-- Installation always DISABLES the named job until a live check passes.
-- Synchronous http keeps Authorization in memory; pg_net is not used here.
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
begin
  if to_regclass('public.purchase_evidence_jobs') is null
     or to_regclass('public.indexer_jobs') is null
     or to_regclass('public.distribution_plans') is null then
    raise exception 'Complete the reviewed migrations before installing the worker';
  end if;
  if (select count(*) from vault.decrypted_secrets
      where name='mancipatio_retry_worker_devnet'
        and length(decrypted_secret)>=32
        and decrypted_secret !~ '[[:space:]]') <> 1 then
    raise exception 'Expected one configured devnet retry credential in Vault';
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

create or replace function mancipatio_ops.invoke_retry_worker_devnet()
returns bigint language plpgsql security definer set search_path='' set lock_timeout='3s' as $$
declare
  worker_secret text; result extensions.http_response; payload jsonb;
  started timestamptz:=clock_timestamp(); finished timestamptz; run_id bigint;
  status_code integer; succeeded boolean:=false; result_kind text:='configuration_error';
  worker_state text; counters integer[]:=array[null,null,null,null,null,null]::integer[];
  path text[]; value text; position integer:=1;
begin
  begin
    select decrypted_secret into strict worker_secret
      from vault.decrypted_secrets where name='mancipatio_retry_worker_devnet';
  exception when others then worker_secret:=null;
  end;
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
        'POST','https://www.manci.io/api/internal/retry?limit=10',
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
          if payload->'ok'='true'::jsonb and payload#>>'{data,network}'='devnet'
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
revoke all on function mancipatio_ops.invoke_retry_worker_devnet()
  from public,anon,authenticated,service_role;

do $$
begin
  if has_schema_privilege('anon','mancipatio_ops','USAGE')
     or has_schema_privilege('authenticated','mancipatio_ops','USAGE')
     or has_function_privilege('anon','mancipatio_ops.invoke_retry_worker_devnet()','EXECUTE')
     or has_function_privilege('authenticated','mancipatio_ops.invoke_retry_worker_devnet()','EXECUTE')
     or has_table_privilege('anon','mancipatio_ops.retry_http_runs','SELECT')
     or has_table_privilege('authenticated','mancipatio_ops.retry_http_runs','SELECT')
     or has_table_privilege('anon','vault.decrypted_secrets','SELECT')
     or has_table_privilege('authenticated','vault.decrypted_secrets','SELECT') then
    raise exception 'Worker operation or Vault is exposed to browser roles';
  end if;
end;
$$;

select cron.schedule('mancipatio-retry-devnet','* * * * *',
  'set statement_timeout=''60s''; select mancipatio_ops.invoke_retry_worker_devnet();');
select cron.alter_job(jobid,active:=false)
  from cron.job where jobname='mancipatio-retry-devnet';
commit;
