-- 0019: Whitepapers / basic token information (Flows doc section 10).
-- An issuer either publishes a proper whitepaper (preferred) or the platform
-- publishes the submitted form information. Some Serbian issues additionally
-- need Securities Commission approval for the whitepaper.

alter table public.asset_profiles
  add column if not exists whitepaper_path text,
  add column if not exists whitepaper_sha256 text,
  add column if not exists whitepaper_url text,
  add column if not exists whitepaper_status text not null default 'none'
    check (whitepaper_status in ('none', 'draft', 'published', 'ssc_approval_pending', 'ssc_approved')),
  add column if not exists whitepaper_published_at timestamptz;
