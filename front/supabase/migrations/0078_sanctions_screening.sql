-- 0078 (8.5): wallet sanctions screening, the baseline without a provider
-- (pravo-compliance-3, ops-qa-4, lansiranje-4).
--
-- EXPAND step: new tables and functions only; nothing existing changes, so
-- it is safe with the front that is live when it is applied.
--
--  1. sanctions_addresses: every Solana address on a screening list, today
--     the US Treasury OFAC SDN list ("Digital Currency Address - SOL" and any
--     other currency tag whose address is a 32-byte base58 Solana key). The
--     daily refresh (POST /api/internal/sanctions, lib/server/sanctions-
--     refresh.ts, scheduled by scripts/ops/sanctions-scheduler.sql) replaces
--     a source's set atomically.
--  2. sanctions_list_state: per source, the last publication loaded
--     (publish date, record and address counts, SHA-256 of the file) and the
--     last attempt with its outcome code. The routes screen against it and,
--     on mainnet, refuse while the last successful refresh is older than
--     3 days or loaded no address (fail closed, lib/server/sanctions.ts).
--  3. replace_sanctions_list(): the one writer of a source's set (upsert the
--     new rows, delete the ones no longer listed, stamp the state) in one
--     transaction. It refuses an empty set: a publication without a single
--     Solana address means the parser no longer matches the format, and the
--     previous set stays in force until a human looks.
--     record_sanctions_refresh_failure(): stamps a failed attempt (code only).
--  4. raise_sanctions_hit(): opens ONE compliance alert per network, wallet
--     and source while none is open or escalated (critical, emailed through
--     the 0072 outbox), linked to the wallet's client dossier when there is
--     one. An open alert blocks passport issuance (api/compliance/open-wallets).
--  5. compliance_alerts' table comment says what it really holds (0005's
--     "daily screening cron (sub-processor TBD)" never existed).
--
-- Every new table and function is service_role only (RLS on, browser roles
-- revoked). The lists carry no network column: a list is the same on every
-- cluster, and each Supabase project loads its own copy.
--
-- Rollback (not a migration): drop the functions and the two tables; no
-- other object references them.
--
-- Re-runnable: every statement is idempotent.
begin;
set local lock_timeout = '15s';

do $$
begin
  if to_regclass('public.compliance_alerts') is null
     or to_regprocedure('public.deployment_network()') is null then
    raise exception 'Apply 0005 and 0070 before 0078';
  end if;
end;
$$;

-- ── 1. The addresses ──────────────────────────────────────────────────────
create table if not exists public.sanctions_addresses (
  source text not null check (source ~ '^[a-z][a-z0-9-]{1,40}$'),
  address text not null check (address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  -- The list's own currency tag ("SOL", "USDC", …): which asset it named.
  currency text not null check (currency ~ '^[A-Z0-9]{1,12}$'),
  entry_uid text check (entry_uid is null or entry_uid ~ '^[0-9]{1,12}$'),
  entry_name text check (entry_name is null or length(entry_name) between 1 and 300),
  programs text[] not null default '{}',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (source, address)
);
create index if not exists sanctions_addresses_address_idx on public.sanctions_addresses(address);
alter table public.sanctions_addresses enable row level security;
revoke all on public.sanctions_addresses from public, anon, authenticated;
grant all on public.sanctions_addresses to service_role;
comment on table public.sanctions_addresses is
  'Solana addresses on a screening list (0078). Written only by replace_sanctions_list().';

-- ── 2. The state of each list ─────────────────────────────────────────────
create table if not exists public.sanctions_list_state (
  source text primary key check (source ~ '^[a-z][a-z0-9-]{1,40}$'),
  published_on date,
  record_count integer check (record_count is null or record_count >= 0),
  address_count integer check (address_count is null or address_count >= 0),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  -- The last SUCCESSFUL refresh: the freshness the routes check.
  refreshed_at timestamptz,
  last_attempt_at timestamptz,
  last_status text check (last_status is null or last_status in ('ok', 'failed')),
  last_error text check (last_error is null or last_error ~ '^[A-Z_]{1,40}$')
);
alter table public.sanctions_list_state enable row level security;
revoke all on public.sanctions_list_state from public, anon, authenticated;
grant all on public.sanctions_list_state to service_role;
comment on table public.sanctions_list_state is
  'Per screening list: the last publication loaded and the last refresh attempt (0078). Codes only, never messages.';

-- ── 3. The writers ────────────────────────────────────────────────────────
-- p_addresses: [{address, currency, entry_uid, entry_name, programs}]
create or replace function public.replace_sanctions_list(
  p_source text, p_published_on date, p_record_count integer, p_sha256 text, p_addresses jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  n integer;
  removed integer;
begin
  if p_source is null or p_source !~ '^[a-z][a-z0-9-]{1,40}$'
     or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$'
     or p_record_count is null or p_record_count < 0
     or p_addresses is null or jsonb_typeof(p_addresses) <> 'array' then
    raise exception 'Invalid sanctions list' using errcode = '22023';
  end if;
  n := jsonb_array_length(p_addresses);
  if n = 0 then
    raise exception 'A sanctions list without a single address is refused (format change?)' using errcode = '22023';
  end if;
  -- One refresh at a time per source.
  perform pg_advisory_xact_lock(hashtext('sanctions_list:' || p_source));

  with incoming as (
    select distinct on (e->>'address')
      e->>'address' as address,
      coalesce(e->>'currency', 'SOL') as currency,
      nullif(e->>'entry_uid', '') as entry_uid,
      nullif(left(e->>'entry_name', 300), '') as entry_name,
      coalesce(array(select jsonb_array_elements_text(coalesce(e->'programs', '[]'::jsonb))), '{}') as programs
    from jsonb_array_elements(p_addresses) e
    order by e->>'address'
  )
  insert into public.sanctions_addresses as s (source, address, currency, entry_uid, entry_name, programs)
    select p_source, i.address, i.currency, i.entry_uid, i.entry_name, i.programs from incoming i
  on conflict (source, address) do update
    set currency = excluded.currency, entry_uid = excluded.entry_uid, entry_name = excluded.entry_name,
        programs = excluded.programs, last_seen_at = now();
  delete from public.sanctions_addresses s
    where s.source = p_source
      and not exists (select 1 from jsonb_array_elements(p_addresses) e where e->>'address' = s.address);
  get diagnostics removed = row_count;
  select count(*) into n from public.sanctions_addresses where source = p_source;

  insert into public.sanctions_list_state as st (source, published_on, record_count, address_count, sha256,
    refreshed_at, last_attempt_at, last_status, last_error)
  values (p_source, p_published_on, p_record_count, n, p_sha256, now(), now(), 'ok', null)
  on conflict (source) do update
    set published_on = excluded.published_on, record_count = excluded.record_count,
        address_count = excluded.address_count, sha256 = excluded.sha256, refreshed_at = now(),
        last_attempt_at = now(), last_status = 'ok', last_error = null;
  return jsonb_build_object('source', p_source, 'addresses', n, 'removed', removed);
end;
$$;
revoke all on function public.replace_sanctions_list(text, date, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.replace_sanctions_list(text, date, integer, text, jsonb) to service_role;

create or replace function public.record_sanctions_refresh_failure(p_source text, p_error text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_source is null or p_source !~ '^[a-z][a-z0-9-]{1,40}$'
     or p_error is null or p_error !~ '^[A-Z_]{1,40}$' then
    raise exception 'Invalid sanctions refresh failure' using errcode = '22023';
  end if;
  insert into public.sanctions_list_state as st (source, last_attempt_at, last_status, last_error)
  values (p_source, now(), 'failed', p_error)
  on conflict (source) do update
    set last_attempt_at = now(), last_status = 'failed', last_error = excluded.last_error;
end;
$$;
revoke all on function public.record_sanctions_refresh_failure(text, text) from public, anon, authenticated;
grant execute on function public.record_sanctions_refresh_failure(text, text) to service_role;

-- ── 4. A screening hit → one compliance alert ─────────────────────────────
create or replace function public.raise_sanctions_hit(
  p_network text, p_wallet text, p_source text, p_hit_list text, p_summary text, p_evidence jsonb,
  p_tx_signature text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  existing uuid;
  new_id uuid;
  client uuid;
begin
  if p_network is null or p_network not in ('devnet', 'mainnet', 'testnet', 'localnet')
     or p_wallet is null or p_wallet !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     or p_source is null or p_source !~ '^[a-z][a-z0-9-]{1,40}$'
     or p_hit_list is null or length(p_hit_list) not between 1 and 200
     or p_summary is null or length(p_summary) not between 1 and 500
     or p_evidence is null or jsonb_typeof(p_evidence) <> 'object'
     or octet_length(p_evidence::text) > 10240
     or (p_tx_signature is not null and p_tx_signature !~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$') then
    raise exception 'Invalid sanctions hit' using errcode = '22023';
  end if;
  -- One open alert per network, wallet and source, even under concurrent hits.
  perform pg_advisory_xact_lock(hashtext('sanctions_hit:' || p_network || ':' || p_wallet || ':' || p_source));
  select a.id into existing from public.compliance_alerts a
    where a.network = p_network and a.wallet = p_wallet and a.source = p_source
      and a.status in ('open', 'escalated')
    order by a.created_at limit 1;
  if existing is not null then
    return jsonb_build_object('id', existing, 'inserted', false);
  end if;
  select c.id into client from public.clients c
    where c.wallet = p_wallet and c.network = p_network order by c.created_at limit 1;
  insert into public.compliance_alerts(network, client_id, wallet, source, severity, confidence, hit_list, evidence,
    summary, status, tx_signature, notify_state, next_notify_at)
  values (p_network, client, p_wallet, p_source, 'critical', 100, p_hit_list, p_evidence, p_summary, 'open',
    p_tx_signature, 'pending', now())
  returning id into new_id;
  return jsonb_build_object('id', new_id, 'inserted', true);
end;
$$;
revoke all on function public.raise_sanctions_hit(text, text, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.raise_sanctions_hit(text, text, text, text, text, jsonb, text) to service_role;

-- ── 5. What compliance_alerts really holds (0005 promised a "daily
-- screening cron (sub-processor TBD)" that never existed) ──────────────────
comment on table public.compliance_alerts is
  'AML / sanctions alerts reviewed in /admin/compliance: manual findings, system alarms (0072) and, since 0078, '
  'wallet screening hits against the OFAC SDN list (raise_sanctions_hit). A wallet is screened when it commits, '
  'records a purchase, requests an OTC escrow, lists for resale, applies for or is issued a passport, or submits '
  'verification, and (alarm worker) when the indexer sees it sign an on-chain buy, OTC offer or take; the list is '
  'refreshed daily. Holders are not rescreened in batch yet.';

commit;
