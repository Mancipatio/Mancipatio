-- 0041: Onboarding magic-link TTL (KYC pipeline hygiene).
-- The onboarding_token (0003) was a forever-valid bearer secret: anyone who
-- ever saw an invite URL could read the client's row and upload documents in
-- their name indefinitely. This adds an explicit expiry:
--
--   * onboarding_token_expires_at — stamped whenever a token is (re)issued
--     (clients/create, passport/submit auto-provisioning, request-docs
--     re-issue). Default policy: 14 days.
--   * requireClientToken (app/api/clients/_helpers.ts) rejects presented
--     tokens past this timestamp; rows with a token but a NULL expiry fall
--     back to created_at + 14 days server-side.
--   * The token is nulled entirely when the client reaches
--     kyc_status='verified' (onboarding complete — all further access is
--     wallet-signed), and its remaining validity is capped to 7 days after a
--     successful link-wallet.
--
-- Backfill: outstanding invites get a fresh 14-day window from the moment the
-- migration runs, so already-shared links are not killed mid-flight.

alter table public.clients
  add column if not exists onboarding_token_expires_at timestamptz;

update public.clients
   set onboarding_token_expires_at = now() + interval '14 days'
 where onboarding_token is not null
   and onboarding_token_expires_at is null;

comment on column public.clients.onboarding_token_expires_at is
  'Expiry of the magic-link onboarding_token (14-day TTL; null when no token is outstanding).';

-- ── Duplicate-dossier guard (auto-provisioning hardening) ────────────────────
-- /api/passport/submit auto-provisions a dossier per wallet with a
-- read-then-insert (TOCTOU) pattern; without a uniqueness guarantee two
-- concurrent submits — or an admin-created row racing a self-service
-- application — can produce two dossiers for the same wallet, splitting
-- kyc_requirements and documents across rows ("oldest wins" lookups then show
-- one row while the evidence lives on the other). A partial unique index
-- closes the race:
--   * passport/submit handles 23505 by adopting the winning row;
--   * clients/create returns 409 for a pre-known wallet that already has a
--     dossier;
--   * clients/link-wallet returns 409 instead of silently creating the
--     second same-wallet row (operator merges/resets instead).
-- Matching by EMAIL was considered and rejected for the submit flow: the
-- self-service application carries no email (dossiers are provisioned from a
-- wallet alone), so an email match can never fire there — the constraint is
-- the effective guard.
--
-- Created conditionally: if historical duplicates already exist the index
-- cannot be built without data surgery, and merging dossiers is an ops
-- decision, not a migration's — in that case raise a LOUD warning and skip,
-- leaving behaviour unchanged until ops dedupes and re-runs the CREATE.
do $$
begin
  if exists (
    select 1
      from public.clients
     where wallet is not null
     group by wallet
    having count(*) > 1
  ) then
    raise warning '0041: public.clients has duplicate wallet values — clients_wallet_unique NOT created. Dedupe manually, then run: create unique index clients_wallet_unique on public.clients (wallet) where wallet is not null;';
  else
    create unique index if not exists clients_wallet_unique
      on public.clients (wallet)
      where wallet is not null;
  end if;
end
$$;
