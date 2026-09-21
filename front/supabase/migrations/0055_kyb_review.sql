-- KYB gets its own review decision. A company verification must never
-- inherit an individual's KYC approval just because both share a dossier.
-- clients.kyc_status stays the source of truth for individual KYC; the KYB
-- row's status is the source of truth for company verification (/apply).
begin;

alter table public.client_verification_details
  add column status text not null default 'pending' check (status in ('pending','verified','rejected')),
  add column reviewed_at timestamptz,
  add column reviewed_by text check (reviewed_by is null or reviewed_by ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  add column review_note text check (length(review_note) <= 1000),
  add constraint client_verification_details_review_consistent
    check ((status = 'pending') = (reviewed_at is null) and (reviewed_at is null) = (reviewed_by is null));

commit;
