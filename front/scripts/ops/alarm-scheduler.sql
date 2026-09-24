-- Alarm-worker scheduler (Talas 4.4b): pg_cron calls the site's
-- /api/internal/alarms every minute, on its own job (D7), so a stalled retry
-- worker cannot silence the alarms that watch it. After migration 0072 and
-- the retry scheduler; run through db.sh, which asserts the target:
--   MANCI_TARGET=<t> bash scripts/db.sh -f scripts/ops/alarm-scheduler.sql
-- (mainnet also needs MANCI_ALLOW_MAINNET=1).
--
-- The worker target is the retry scheduler's single-row
-- mancipatio_ops.retry_worker_config (network + origin; one worker origin per
-- project): this install refuses unless that row exists, names this
-- project's network (public.deployment_network(), migration 0070) and the
-- target's siteOrigin. The Vault secret is the same one
-- ('mancipatio_retry_worker_<network>', D8).
--
-- Installation always DISABLES 'mancipatio-alarms-<network>' until a live
-- check passes; enable it with
--   select cron.alter_job(jobid, active := true) from cron.job where jobname = 'mancipatio-alarms-<network>';
-- A run counts as complete only when the response names this network
-- (data.network) and the worker says busy or processed; anything else is
-- recorded as invalid_response. Only counts and fixed states are stored.

\o /dev/null
select pg_catalog.set_config('manci.alarm_origin', :'target_origin', false);
\o

begin;

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists http with schema extensions;

do $$
declare
  net text;
  target_network text := current_setting('manci.target_network', true);
  origin text := current_setting('manci.alarm_origin', true);
  configured record;
begin
  if to_regclass('public.onchain_event_jobs') is null or to_regprocedure('public.acquire_worker_lease(text,text,uuid,integer)') is null then
    raise exception 'Apply migration 0072 before installing the alarm worker';
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
  if to_regclass('mancipatio_ops.retry_worker_config') is null then
    raise exception 'Install scripts/ops/retry-scheduler.sql first: the alarm worker uses its worker target';
  end if;
  select c.network, c.origin into configured from mancipatio_ops.retry_worker_config c;
  if not found or configured.network is distinct from net then
    raise exception 'The worker target (mancipatio_ops.retry_worker_config) does not name this % project', net;
  end if;
  if origin is null or origin = '-' or configured.origin is distinct from origin then
    raise exception 'The worker target origin % is not the target''s siteOrigin %', configured.origin, coalesce(origin, '(none)');
  end if;
  if (select count(*) from vault.decrypted_secrets
      where name='mancipatio_retry_worker_'||net
        and length(decrypted_secret)>=32
        and decrypted_secret !~ '[[:space:]]') <> 1 then
    raise exception 'Expected one configured % worker credential in Vault (mancipatio_retry_worker_%)', net, net;
  end if;
end;
$$;

create table if not exists mancipatio_ops.alarm_http_runs (
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
  events_complete integer,events_pending integer,events_invalid integer,
  checks_reported integer,checks_failing integer,
  notify_state text check(notify_state in ('sent','failed','none','deferred','not_configured'))
);
alter table mancipatio_ops.alarm_http_runs enable row level security;
revoke all on mancipatio_ops.alarm_http_runs from public,anon,authenticated,service_role;
revoke all on sequence mancipatio_ops.alarm_http_runs_id_seq from public,anon,authenticated,service_role;
create index if not exists alarm_http_runs_requested_at_idx on mancipatio_ops.alarm_http_runs(requested_at);

create or replace function mancipatio_ops.invoke_alarm_worker()
returns bigint language plpgsql security definer set search_path='' set lock_timeout='3s' as $$
declare
  net text; worker_origin text;
  worker_secret text; result extensions.http_response; payload jsonb;
  started timestamptz:=clock_timestamp(); finished timestamptz; run_id bigint;
  status_code integer; succeeded boolean:=false; result_kind text:='configuration_error';
  worker_state text; notify text; counters integer[]:=array[null,null,null,null,null]::integer[];
  path text[]; value text; position integer:=1;
begin
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
      perform pg_catalog.set_config('http.timeout_msec','55000',true);
      select * into result from extensions.http((
        'POST',worker_origin||'/api/internal/alarms?limit=20',
        array[('Authorization','Bearer '||worker_secret)::extensions.http_header],
        'application/json','{}'
      )::extensions.http_request);
      worker_secret:=null;
      status_code:=result.status;
      result_kind:='http_error';
      if result.status in (200,503) then
        result_kind:='invalid_response';
        begin
          payload:=result.content::jsonb;
          -- A response bound to another network never counts as a run.
          if payload#>>'{data,network}' is distinct from net then
            payload:=null;
          else
            if result.status=200 and payload->'ok'='true'::jsonb
               and payload#>>'{data,status}' in ('busy','processed') then
              succeeded:=true;result_kind:='complete';
            elsif result.status=503 then
              result_kind:='http_error';
            end if;
            if payload#>>'{data,status}' in ('busy','processed','partial') then
              worker_state:=payload#>>'{data,status}';
            end if;
            if payload#>>'{data,notify,status}' in ('sent','failed','none','deferred','not_configured') then
              notify:=payload#>>'{data,notify,status}';
            end if;
            foreach path slice 1 in array array[
              array['data','events','counts','complete'],array['data','events','counts','pending'],array['data','events','counts','invalid'],
              array['data','checks','counts','reported'],array['data','checks','counts','failing']
            ] loop
              value:=payload#>>path;
              if value ~ '^[0-9]{1,9}$' then counters[position]:=value::integer;end if;
              position:=position+1;
            end loop;
          end if;
        exception when others then succeeded:=false;result_kind:='invalid_response';
        end;
      end if;
    exception
      when query_canceled then result_kind:='timeout';
      when others then result_kind:='transport_error';
    end;
    worker_secret:=null;payload:=null;result:=null;
    perform extensions.http_reset_curlopt();
  end if;
  finished:=clock_timestamp();
  insert into mancipatio_ops.alarm_http_runs(
    requested_at,completed_at,duration_ms,http_status,ok,outcome,worker_state,
    events_complete,events_pending,events_invalid,checks_reported,checks_failing,notify_state
  ) values(
    started,finished,greatest(0,(extract(epoch from finished-started)*1000)::integer),
    status_code,succeeded,result_kind,worker_state,counters[1],counters[2],counters[3],counters[4],counters[5],notify
  ) returning id into run_id;
  delete from mancipatio_ops.alarm_http_runs where id in (
    select id from mancipatio_ops.alarm_http_runs
      where requested_at<now()-interval '7 days' order by requested_at limit 1000
  );
  return run_id;
end;
$$;
revoke all on function mancipatio_ops.invoke_alarm_worker() from public,anon,authenticated,service_role;

do $$
begin
  if has_schema_privilege('anon','mancipatio_ops','USAGE')
     or has_schema_privilege('authenticated','mancipatio_ops','USAGE')
     or has_function_privilege('anon','mancipatio_ops.invoke_alarm_worker()','EXECUTE')
     or has_function_privilege('authenticated','mancipatio_ops.invoke_alarm_worker()','EXECUTE')
     or has_table_privilege('anon','mancipatio_ops.alarm_http_runs','SELECT')
     or has_table_privilege('authenticated','mancipatio_ops.alarm_http_runs','SELECT')
     or has_table_privilege('anon','vault.decrypted_secrets','SELECT')
     or has_table_privilege('authenticated','vault.decrypted_secrets','SELECT') then
    raise exception 'Worker operation or Vault is exposed to browser roles';
  end if;
end;
$$;

select cron.schedule('mancipatio-alarms-'||public.deployment_network(),'* * * * *',
  'set statement_timeout=''60s''; select mancipatio_ops.invoke_alarm_worker();');
select cron.alter_job(jobid,active:=false)
  from cron.job where jobname='mancipatio-alarms-'||public.deployment_network();

do $$
declare
  job_name text := 'mancipatio-alarms-'||public.deployment_network();
  expected text := 'set statement_timeout=''60s''; select mancipatio_ops.invoke_alarm_worker();';
  named integer;
  good integer;
begin
  select count(*), count(*) filter (where not active and command = expected)
    into named, good
    from cron.job where jobname = job_name;
  if named <> 1 or good <> 1 then
    raise exception 'Expected exactly one disabled % job running mancipatio_ops.invoke_alarm_worker(); found % job(s) with that name.', job_name, named;
  end if;
end;
$$;

select j.jobname, j.active, c.network, c.origin
from cron.job j cross join mancipatio_ops.retry_worker_config c
where j.jobname='mancipatio-alarms-'||public.deployment_network();
commit;
