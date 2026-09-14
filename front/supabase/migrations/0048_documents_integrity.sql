begin;
-- File bodies are first placed in a private bucket. No public object is
-- created until the server hashes the actual stored bytes.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('document-uploads','document-uploads',false,26214400,array['application/pdf','image/png','image/jpeg','application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create table public.document_uploads (
  id uuid primary key,network text not null, wallet text not null,
  bucket text not null,path text not null,staging_path text not null unique,
  sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),size_bytes integer not null check(size_bytes between 1 and 26214400),
  mime_type text not null,verified_version_id uuid,created_at timestamptz not null default now()
);
create table public.document_versions (
  id uuid primary key default gen_random_uuid(),network text not null,bucket text not null,path text not null,
  sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),size_bytes integer not null check(size_bytes between 1 and 26214400),
  mime_type text not null,verified_by text not null,verified_at timestamptz not null default now(),
  unique(network,bucket,path)
);
alter table public.document_uploads add foreign key(verified_version_id) references public.document_versions(id);
alter table public.document_uploads enable row level security;
alter table public.document_versions enable row level security;
revoke all on public.document_uploads,public.document_versions from anon,authenticated;
grant select,insert,update,delete on public.document_uploads to service_role;
grant select,insert on public.document_versions to service_role;
create function public.immutable_document_version() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'verified document versions are immutable'; end;
$$;
create trigger document_versions_immutable before update or delete on public.document_versions for each row execute function public.immutable_document_version();
alter table public.asset_profiles add column whitepaper_version_id uuid references public.document_versions(id),
  add column ssc_decision_version_id uuid references public.document_versions(id);
alter table public.documents add column verified_version_id uuid references public.document_versions(id);
alter table public.commitments add column document_version_id uuid references public.document_versions(id),add column terms_acceptance jsonb;
drop function if exists public.record_soft_commitment(text,text,text,numeric);
create function public.record_soft_commitment(p_network text,p_sale text,p_wallet text,p_amount numeric,p_document uuid,p_acceptance jsonb)
returns uuid language plpgsql set search_path='' as $$
declare existing public.commitments%rowtype;result uuid;
begin
  if p_network not in ('devnet','mainnet','testnet','localnet') or p_amount is null or p_amount <= 0 or p_acceptance is null
    or not exists(select 1 from public.document_versions where id=p_document and network=p_network) then
    raise exception 'verified document acceptance and valid commitment terms are required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_network || ':' || p_sale || ':' || p_wallet,0));
  select * into existing from public.commitments where network=p_network and sale_pubkey=p_sale and investor_wallet=p_wallet
    and status in ('pending','confirmed') for update;
  if found then
    if existing.amount is distinct from p_amount or existing.document_version_id is distinct from p_document then
      raise exception 'an active pledge with different terms already exists' using errcode='23505';
    end if;
    return existing.id;
  end if;
  insert into public.commitments(network,sale_pubkey,investor_wallet,amount,status,document_version_id,terms_acceptance)
    values(p_network,p_sale,p_wallet,p_amount,'pending',p_document,p_acceptance) returning id into result;
  return result;
end;
$$;
revoke all on function public.record_soft_commitment(text,text,text,numeric,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.record_soft_commitment(text,text,text,numeric,uuid,jsonb) to service_role;
-- Historical paths/hashes remain declarations; they are never auto-verified.
create function public.guard_verified_profile_document() returns trigger language plpgsql set search_path='' as $$
declare version public.document_versions%rowtype;
begin
  if new.whitepaper_version_id is not null then
    select * into version from public.document_versions where id=new.whitepaper_version_id;
    if not found or version.network is distinct from new.network or version.bucket <> 'documents'
      or version.path not like ('whitepapers/' || new.asset_pda || '/%')
      or version.path is distinct from new.whitepaper_path or version.sha256 is distinct from new.whitepaper_sha256 then
      raise exception 'whitepaper must match a verified immutable version';
    end if;
  end if;
  if new.ssc_decision_version_id is not null then
    select * into version from public.document_versions where id=new.ssc_decision_version_id;
    if not found or version.network is distinct from new.network or version.bucket <> 'documents'
      or version.path not like ('whitepapers/' || new.asset_pda || '/%')
      or version.path is distinct from new.ssc_decision_doc_path or version.sha256 is distinct from new.ssc_decision_doc_sha256 then
      raise exception 'SSC document must match a verified immutable version';
    end if;
  end if;
  return new;
end;
$$;
create trigger asset_profiles_verified_documents before insert or update on public.asset_profiles for each row execute function public.guard_verified_profile_document();
create function public.guard_document_record_version() returns trigger language plpgsql set search_path='' as $$
declare version public.document_versions%rowtype;
begin
  if tg_op='UPDATE' and old.verified_version_id is not null and (new.verified_version_id is distinct from old.verified_version_id
    or new.storage_path is distinct from old.storage_path or new.sha256 is distinct from old.sha256
    or new.size_bytes is distinct from old.size_bytes or new.mime_type is distinct from old.mime_type) then
    raise exception 'verified document metadata is immutable';
  end if;
  if new.verified_version_id is not null then
    select * into version from public.document_versions where id=new.verified_version_id;
    if not found or version.path is distinct from new.storage_path or version.sha256 is distinct from new.sha256
      or version.size_bytes is distinct from new.size_bytes or version.mime_type is distinct from new.mime_type then
      raise exception 'document metadata must match its verified bytes';
    end if;
  end if;
  return new;
end;
$$;
create trigger documents_verified_version before insert or update on public.documents for each row execute function public.guard_document_record_version();
create function public.publish_document_version(p_id uuid,p_network text) returns integer language plpgsql set search_path='' as $$
declare target public.documents%rowtype;
begin
  select * into target from public.documents where id=p_id;
  if not found then raise exception 'document not found'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target.category || ':' || target.slug,0));
  if not exists(select 1 from public.document_versions where id=target.verified_version_id and network=p_network) then
    raise exception 'verify an immutable uploaded version before publication';
  end if;
  update public.documents set published=false where category=target.category and slug=target.slug and id<>p_id and published;
  update public.documents set published=true,published_at=coalesce(published_at,now()) where id=p_id;
  return target.version;
end;
$$;
revoke all on function public.publish_document_version(uuid,text) from public,anon,authenticated;
grant execute on function public.publish_document_version(uuid,text) to service_role;
commit;
