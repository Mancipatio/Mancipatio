begin;
alter table public.launch_applications add column if not exists network text not null default 'devnet';
alter table public.launch_listings add column if not exists network text not null default 'devnet';
alter table public.launch_updates add column if not exists network text not null default 'devnet';
alter table public.launch_listings drop constraint launch_listings_pkey;
alter table public.launch_listings add primary key(network,sale_pubkey);
create unique index launch_listings_application_once on public.launch_listings(network,application_id) where application_id is not null;
create index launch_applications_network_idx on public.launch_applications(network,created_at);
create index launch_updates_network_sale_idx on public.launch_updates(network,sale_pubkey);
-- Published listing/update projection only. Private application readers remain
-- signed; their server queries must use the same network.
do $$ declare p record;begin
  for p in select tablename,policyname from pg_policies where schemaname='public' and tablename in ('launch_listings','launch_updates') loop
    execute format('drop policy %I on public.%I',p.policyname,p.tablename);
  end loop;
end;$$;
alter table public.launch_listings enable row level security;
alter table public.launch_updates enable row level security;
create policy launch_listings_published_read on public.launch_listings for select to anon,authenticated using(is_published);
create policy launch_updates_published_read on public.launch_updates for select to anon,authenticated using(exists(
  select 1 from public.launch_listings l where l.network=launch_updates.network and l.sale_pubkey=launch_updates.sale_pubkey and l.is_published));
grant select on public.launch_listings,public.launch_updates to anon,authenticated;
grant select,insert,update on public.launch_listings,public.launch_applications to service_role;

create function public.save_launch_listing(p_network text,p_sale text,p_issuer text,p_admin boolean,p_listing jsonb)
returns text language plpgsql set search_path='' as $$
declare existing public.launch_listings%rowtype; application public.launch_applications%rowtype;app_id uuid;
begin
  if p_network not in ('devnet','mainnet','testnet','localnet') or p_issuer is null then raise exception 'valid network and verified sale issuer required';end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('listing:' || p_network || ':' || p_sale,0));
  select * into existing from public.launch_listings where network=p_network and sale_pubkey=p_sale for update;
  app_id=case when p_listing ? 'application_id' then (p_listing->>'application_id')::uuid else existing.application_id end;
  if existing.application_id is not null and app_id is distinct from existing.application_id then raise exception 'a linked application cannot be replaced';end if;
  if app_id is not null then
    select * into application from public.launch_applications where id=app_id and network=p_network for update;
    if not found or application.status <> 'approved' then raise exception 'application must be approved on this network';end if;
    if not p_admin and application.applicant_wallet is distinct from p_issuer and application.linked_issuer is distinct from p_issuer then raise exception 'application does not belong to this issuer';end if;
    if application.linked_sale_pubkey is not null and application.linked_sale_pubkey <> p_sale then raise exception 'application is already linked to another sale';end if;
  end if;
  insert into public.launch_listings(network,sale_pubkey,application_id,logo_letter,logo_gradient,problem,why_now,traction,existing_investors,is_published)
  values(p_network,p_sale,app_id,
    case when p_listing ? 'logo_letter' then p_listing->>'logo_letter' else existing.logo_letter end,
    case when p_listing ? 'logo_gradient' then p_listing->>'logo_gradient' else existing.logo_gradient end,
    case when p_listing ? 'problem' then p_listing->>'problem' else existing.problem end,
    case when p_listing ? 'why_now' then p_listing->>'why_now' else existing.why_now end,
    coalesce(p_listing->'traction',existing.traction,'{}'::jsonb),
    case when p_listing ? 'existing_investors' then p_listing->>'existing_investors' else existing.existing_investors end,
    coalesce((p_listing->>'is_published')::boolean,existing.is_published,false))
  on conflict(network,sale_pubkey) do update set application_id=excluded.application_id,logo_letter=excluded.logo_letter,
    logo_gradient=excluded.logo_gradient,problem=excluded.problem,why_now=excluded.why_now,traction=excluded.traction,
    existing_investors=excluded.existing_investors,is_published=excluded.is_published;
  if app_id is not null then
    update public.launch_applications set linked_sale_pubkey=p_sale,linked_issuer=p_issuer where id=app_id and network=p_network;
  end if;
  return p_sale;
end;
$$;
revoke all on function public.save_launch_listing(text,text,text,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.save_launch_listing(text,text,text,boolean,jsonb) to service_role;
commit;
