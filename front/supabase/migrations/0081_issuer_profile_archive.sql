-- 0081: archive (soft delete, off chain) of an issuer — owner's request of
-- 2026-10-03 ("opcija da mogu obrisati stvari koje smo ranije testirali ili
-- ne radimo").
--
-- The registry has no close instruction for Issuer, Asset or ShareClass, so an
-- issuer made on chain stays there for good. The platform can only stop
-- showing it: the super admin archives it with a reason (POST
-- /api/archive/set), and the public lists, the issuer workspace and the admin
-- lists (unless "Show archived") leave it and all its assets out
-- (lib/archive.ts).
--
-- ASSETS NEED NO MIGRATION: an archived asset is asset_profiles.status =
-- 'archived' (a value the 0014 check already allows), is_published = false,
-- with the record in fields.archive. Only issuer_profiles lacked a place for
-- it.
--
-- Expand-only and NOT required before the front deploys: until this column
-- exists, /api/archive/list reports issuerArchiveAvailable = false (nothing is
-- hidden for issuers), /api/archive/check shows the issuer dialog as
-- unavailable, and /api/archive/set answers 503 with a plain message for an
-- issuer. Asset archive works either way.
--
--  issuer_profiles.archive jsonb, null = not archived. Shape (lib/archive.ts
--  ArchiveRecord): { reason, archived_by, archived_at, row_created? }. Written
--  only by the server (service role); every change has an audit event
--  (issuer_archive / issuer_unarchive). The table stays service-role only for
--  writes (0025/0031/0044); nothing here changes RLS or grants.

alter table public.issuer_profiles
  add column if not exists archive jsonb;

comment on column public.issuer_profiles.archive is
  'Off-chain archive record (null = not archived): {reason, archived_by, archived_at, row_created?}. Written only by /api/archive/set (super admin). 0081.';
