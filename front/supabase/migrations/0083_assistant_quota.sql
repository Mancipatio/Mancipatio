-- Durable limits for the public assistant. No prompts, answers or raw IPs.
-- Only the service-role RPC may reserve an AI request; rejection spends nothing.
begin;

create table public.assistant_quota (
  bucket text not null check (bucket in ('minute', 'day')),
  key_hash text not null,
  window_start timestamptz not null,
  request_count integer not null check (request_count between 0 and 10000),
  primary key (bucket, key_hash, window_start),
  check ((bucket = 'minute' and key_hash ~ '^[a-f0-9]{64}$') or
         (bucket = 'day' and key_hash = 'global'))
);
alter table public.assistant_quota enable row level security;
revoke all on public.assistant_quota from public, anon, authenticated, service_role;

create function public.consume_assistant_quota(
  p_key_hash text,
  p_minute_limit integer,
  p_daily_limit integer
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  checked_at timestamptz;
  minute_start timestamptz;
  day_start timestamptz;
  minute_count integer;
  day_count integer;
begin
  if p_key_hash is null or p_key_hash !~ '^[a-f0-9]{64}$' or
     p_minute_limit is null or p_minute_limit not between 1 and 60 or
     p_daily_limit is null or p_daily_limit not between 1 and 10000 then
    raise exception 'Invalid assistant quota arguments' using errcode = '22023';
  end if;

  -- A dedicated transaction lock serializes both counters across serverless
  -- instances and UTC rollovers. Read the clock AFTER taking the lock so a
  -- waiter cannot reserve against a window that expired while it was waiting.
  perform pg_catalog.pg_advisory_xact_lock(1296125507, 83);
  checked_at := pg_catalog.clock_timestamp();
  minute_start := pg_catalog.date_trunc('minute', checked_at, 'UTC');
  day_start := pg_catalog.date_trunc('day', checked_at, 'UTC');

  -- Retain only the active IP minute and the global UTC day. Rejected traffic
  -- cannot create additional IP rows, and the daily cap bounds accepted keys.
  delete from public.assistant_quota
    where (bucket = 'minute' and window_start < minute_start)
       or (bucket = 'day' and window_start < day_start);

  select request_count into day_count from public.assistant_quota
    where bucket = 'day' and key_hash = 'global' and window_start = day_start;
  if coalesce(day_count, 0) >= p_daily_limit then return false; end if;

  select request_count into minute_count from public.assistant_quota
    where bucket = 'minute' and key_hash = p_key_hash and window_start = minute_start;
  if coalesce(minute_count, 0) >= p_minute_limit then return false; end if;

  insert into public.assistant_quota (bucket, key_hash, window_start, request_count)
    values ('minute', p_key_hash, minute_start, 1)
    on conflict (bucket, key_hash, window_start) do update
      set request_count = public.assistant_quota.request_count + 1;
  insert into public.assistant_quota (bucket, key_hash, window_start, request_count)
    values ('day', 'global', day_start, 1)
    on conflict (bucket, key_hash, window_start) do update
      set request_count = public.assistant_quota.request_count + 1;
  return true;
end;
$$;

revoke all on function public.consume_assistant_quota(text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.consume_assistant_quota(text, integer, integer)
  to service_role;

commit;
