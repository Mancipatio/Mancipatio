-- 0011_documents_storage.sql
-- Create the documents bucket and its RLS policies so admins can upload
-- files directly from /admin/documents. v0.1 keeps the bucket public-read
-- (terms of service, marketing PDFs, KYB templates are not secret) but
-- writes are open like the rest of v0.1 — to be tightened when we wire
-- Supabase Auth.

insert into storage.buckets (id, name, public)
values ('documents', 'documents', true)
on conflict (id) do update set public = excluded.public;

-- Public read so we can <a href> the served file from the documents table.
drop policy if exists "documents public read" on storage.objects;
create policy "documents public read"
  on storage.objects for select
  using (bucket_id = 'documents');

-- Open writes for v0.1 — admins write through the anon key today. When
-- we move to Supabase Auth, narrow this to authenticated + admin role.
drop policy if exists "documents anon write" on storage.objects;
create policy "documents anon write"
  on storage.objects for insert
  with check (bucket_id = 'documents');

drop policy if exists "documents anon update" on storage.objects;
create policy "documents anon update"
  on storage.objects for update
  using (bucket_id = 'documents')
  with check (bucket_id = 'documents');

drop policy if exists "documents anon delete" on storage.objects;
create policy "documents anon delete"
  on storage.objects for delete
  using (bucket_id = 'documents');
