-- Verification submitted by a wallet-less (email/Google) account.
begin;
alter table public.client_verification_details alter column submitted_by_wallet drop not null;
alter table public.client_verification_details add column submitted_by_account uuid;
alter table public.client_verification_details add constraint client_verification_details_submitter
  check (submitted_by_wallet is not null or submitted_by_account is not null);
commit;
