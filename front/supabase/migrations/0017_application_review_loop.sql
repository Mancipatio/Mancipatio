-- 0017: Iterative application review loop (Flows doc steps 4-5).
-- Adds 'needs_changes' status, resubmission tracking, and an application event log.

do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.launch_applications'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%status%'
  loop
    execute format('alter table public.launch_applications drop constraint %I', c);
  end loop;
end $$;

alter table public.launch_applications
  add constraint launch_applications_status_check
  check (status in ('pending', 'approved', 'rejected', 'needs_changes'));

alter table public.launch_applications
  add column if not exists submitted_at timestamptz not null default now(),
  add column if not exists revision_count integer not null default 0;

-- Backfill submitted_at from created_at for existing rows.
update public.launch_applications set submitted_at = created_at where submitted_at is null;

create table if not exists public.application_events (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  application_id uuid not null references public.launch_applications(id) on delete cascade,
  actor text not null check (actor in ('admin', 'applicant')),
  action text not null check (action in ('submitted', 'resubmitted', 'approved', 'rejected', 'needs_changes')),
  reason text,
  actor_wallet text
);

create index if not exists application_events_app_idx on public.application_events(application_id);

alter table public.application_events enable row level security;
drop policy if exists application_events_read on public.application_events;
create policy application_events_read on public.application_events for select using (true);
drop policy if exists application_events_insert on public.application_events;
create policy application_events_insert on public.application_events for insert with check (true);
