-- 0093: the company behind a token, on its profile.
--
-- A token's public pages named the token and not the company: the company's
-- name lived only in private rows (issuer_profiles, fields.tokenize), there
-- was no place for the people who run it or for its pages elsewhere, and a
-- logo could only be a file the operator added to the repository. This adds
-- them to asset_profiles as deliberately public fields (lib/company-profile.ts
-- holds the rules; lib/profile-public.ts projects them for a published row):
--   company_name   the company as it is named publicly
--   team           one "Name — Role" per person, at most 12
--   link_x / link_linkedin / link_github
--                  the company's page on that service (https, on the
--                  service's own host: POST /api/profiles/upsert checks it)
--   logo_path / logo_sha256
--                  an uploaded PNG or JPEG under logos/<asset PDA>/ in the
--                  public documents bucket, with the SHA-256 of its bytes
--   logo_approved_at / logo_approved_by
--                  an admin's approval of exactly that file; the server
--                  stamps both, and a new or removed file clears them. The
--                  public projection shows logo_path only when approved: a
--                  logo is the fastest way to pass one company off as another.
--
-- EXPAND only: nine nullable columns and CHECKs every existing row (all NULL)
-- satisfies. asset_profiles stays service-role only (0044): no grant changes.
--
-- Order: apply BEFORE the front that reads them, on devnet and on mainnet.
-- That front's public profile read (/api/profiles/public) selects the new
-- public columns, so without this migration it answers 503 and the lists fall
-- back to on-chain names. The front deployed today never selects or writes
-- them, so applying this first changes nothing for it.
begin;
set local lock_timeout = '15s';

alter table public.asset_profiles
  add column if not exists company_name text,
  add column if not exists team text[],
  add column if not exists link_x text,
  add column if not exists link_linkedin text,
  add column if not exists link_github text,
  add column if not exists logo_path text,
  add column if not exists logo_sha256 text,
  add column if not exists logo_approved_at timestamptz,
  add column if not exists logo_approved_by text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'asset_profiles_company_fields'
      and conrelid = 'public.asset_profiles'::regclass
  ) then
    alter table public.asset_profiles
      add constraint asset_profiles_company_fields check (
        (company_name is null or char_length(btrim(company_name)) between 1 and 200)
        and (team is null or (
          cardinality(team) between 1 and 12
          and array_position(team, null) is null
          and char_length(array_to_string(team, '')) <= 12 * 120
        ))
        and (link_x is null or (link_x ~ '^https://' and char_length(link_x) <= 300))
        and (link_linkedin is null or (link_linkedin ~ '^https://' and char_length(link_linkedin) <= 300))
        and (link_github is null or (link_github ~ '^https://' and char_length(link_github) <= 300))
      );
  end if;

  -- The logo is this asset's own file with its hash, or absent; an approval
  -- names a file and carries both stamps.
  if not exists (
    select 1 from pg_constraint
    where conname = 'asset_profiles_logo_complete'
      and conrelid = 'public.asset_profiles'::regclass
  ) then
    alter table public.asset_profiles
      add constraint asset_profiles_logo_complete check (
        (
          (logo_path is null and logo_sha256 is null)
          or (
            -- Both present: a CHECK passes on NULL, so say so before comparing.
            logo_path is not null and logo_sha256 is not null
            and logo_sha256 ~ '^[0-9a-f]{64}$'
            and char_length(logo_path) <= 400
            and left(logo_path, char_length('logos/' || asset_pda || '/')) = 'logos/' || asset_pda || '/'
          )
        )
        and (
          (logo_approved_at is null and logo_approved_by is null)
          or (logo_approved_at is not null and logo_approved_by is not null and logo_path is not null)
        )
      );
  end if;
end;
$$;

comment on column public.asset_profiles.company_name is
  'The company behind the token, as it is named publicly. Written by the issuer or an admin via /api/profiles/upsert; public once the profile is published.';
comment on column public.asset_profiles.team is
  'The people who run the company, one "Name — Role" per entry, at most 12. Written by the issuer or an admin; public once the profile is published.';
comment on column public.asset_profiles.link_x is
  'The company''s page on X (https on x.com or twitter.com; the route checks the host). Public once the profile is published.';
comment on column public.asset_profiles.link_linkedin is
  'The company''s page on LinkedIn (https on linkedin.com; the route checks the host). Public once the profile is published.';
comment on column public.asset_profiles.link_github is
  'The company''s page on GitHub (https on github.com; the route checks the host). Public once the profile is published.';
comment on column public.asset_profiles.logo_path is
  'The company''s logo: a PNG or JPEG under logos/<asset PDA>/ in the public documents bucket, uploaded by the issuer or an admin. Shown publicly only while logo_approved_at is set.';
comment on column public.asset_profiles.logo_sha256 is
  'SHA-256 of the logo file''s bytes, verified by the server (document_versions).';
comment on column public.asset_profiles.logo_approved_at is
  'When an admin approved the logo file named by logo_path; stamped by the server and cleared when the file changes.';
comment on column public.asset_profiles.logo_approved_by is
  'Wallet (admin) that approved the logo; stamped by the server; never public.';

commit;
