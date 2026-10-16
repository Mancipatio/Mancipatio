-- 0082: resell_listings — the public (anon) read is scoped to ACTIVE listings.
--
-- 0025 gave the browser roles a full SELECT ("the admin resell board lists
-- all statuses through the same anon client"), so a matched, withdrawn or
-- removed post stayed readable by anyone holding the anon key (shipped in the
-- browser bundle), with its seller contact (email / Telegram handle), note
-- and moderation fields: the holder who withdrew, and the author of a
-- moderated scam post, kept their contact public. From here on anon and
-- authenticated read only status = 'active' rows — exactly what the public
-- board shows (lib/resell.ts listResellListings({ status: "active" })).
--
-- ============================================================================
-- APPLY ONLY AFTER deploying the front that reads the seller's own history
-- (/portfolio/listings, lib/resell.ts listMyResellListings) and the admin
-- board (/admin/resell, listResellListings()) through a signed route on the
-- service role (a /api/resell/list with scope "mine" | "admin", in the style
-- of /api/otc/list). Applied before that front, both pages still read through
-- the anon client: the seller loses their matched, withdrawn and removed rows,
-- and /admin/resell silently loses every non-active row and with it the
-- Restore button. The public board and every write (signed routes on the
-- service role, which bypasses RLS) do not change either way.
-- ============================================================================
--
-- No column grant and no data change: select('*') keeps working, Restore
-- keeps working and moderation evidence stays. Idempotent: every policy on
-- the table is dropped (0049 style) and the one read policy recreated; the
-- table-level grants are restated. Nothing on-chain is involved: listings
-- are off-chain classifieds. Pinned by tests/resell-listings-rls.test.ts and,
-- against a real cluster, tests/otc-mobile-state-resell-rls.postgres.test.ts.
begin;
set local lock_timeout = '15s';

do $$ declare p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'resell_listings'
  loop
    execute format('drop policy %I on public.resell_listings', p.policyname);
  end loop;
end; $$;

alter table public.resell_listings enable row level security;

-- Browser roles: the public board only. No insert, update or delete policy:
-- every write is a signed route on the service role (0025).
create policy resell_listings_active_read on public.resell_listings
  for select to anon, authenticated
  using (status = 'active');

grant select on public.resell_listings to anon, authenticated;
grant all on public.resell_listings to service_role;

comment on policy resell_listings_active_read on public.resell_listings is
  'Browser roles read active listings only; matched, withdrawn and removed posts (and their seller contact) are private to the signed routes. 0082.';

commit;
