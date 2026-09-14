-- 0023: Custom tokenization inquiries (Flows doc section 8 "Other"): interested
-- party contacts us -> we evaluate -> propose a solution -> separate process.

create table if not exists public.custom_inquiries (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  network text not null default 'devnet',
  name text not null default '',
  email text not null,
  company text,
  asset_kind text,
  idea text not null,
  status text not null default 'new' check (status in ('new', 'in_review', 'proposed', 'agreed', 'rejected', 'archived')),
  admin_note text,
  handled_by text,
  handled_at timestamptz
);

drop trigger if exists custom_inquiries_touch on public.custom_inquiries;
create trigger custom_inquiries_touch before update on public.custom_inquiries
  for each row execute function public.touch_updated_at();

create index if not exists custom_inquiries_status_idx on public.custom_inquiries(status);
create index if not exists custom_inquiries_created_idx on public.custom_inquiries(created_at desc);

alter table public.custom_inquiries enable row level security;
drop policy if exists custom_inquiries_all on public.custom_inquiries;
create policy custom_inquiries_all on public.custom_inquiries for all using (true) with check (true);
