-- 0007_documents.sql
-- Global document repository — Terms of Service, Privacy Policy, KYB
-- templates, issuer agreements, compliance docs. Each upload is a new
-- version; only one version per (category, slug) is "published" at a time.

create table if not exists public.documents (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Category / slug pair identifies a document family across versions.
  -- e.g. category='legal' + slug='terms-of-service'.
  category      text not null
    check (category in ('legal', 'kyb-template', 'issuer-agreement', 'compliance', 'marketing', 'other')),
  slug          text not null,
  version       integer not null default 1,
  title         text not null,
  description   text not null default '',

  -- Storage / hash.
  storage_path  text,                       -- supabase storage bucket path
  external_url  text,                       -- alt: external link instead of upload
  sha256        text,
  size_bytes    bigint,
  mime_type     text,

  -- Publish status — only one row per (category, slug) is published at a time.
  published     boolean not null default false,
  published_at  timestamptz,

  uploaded_by   text not null,              -- admin wallet
  unique (category, slug, version)
);

create index if not exists documents_category_idx on public.documents (category);
create index if not exists documents_published_idx on public.documents (published) where published;
create index if not exists documents_slug_idx on public.documents (slug);

create trigger documents_touch before update on public.documents
  for each row execute function public.touch_updated_at();

alter table public.documents enable row level security;

drop policy if exists "documents anon read"   on public.documents;
create policy "documents anon read"
  on public.documents for select using (true);

drop policy if exists "documents anon insert" on public.documents;
create policy "documents anon insert"
  on public.documents for insert with check (true);

drop policy if exists "documents anon update" on public.documents;
create policy "documents anon update"
  on public.documents for update using (true) with check (true);

drop policy if exists "documents anon delete" on public.documents;
create policy "documents anon delete"
  on public.documents for delete using (true);
