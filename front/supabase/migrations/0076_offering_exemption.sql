-- 0076: offering exemption for mainnet sales (gap 2026-09-28, lansiranje-2).
--
-- On MAINNET a sale may be approved (/api/sale-approvals/reserve) and its
-- document served for purchases and commitments (lib/server/sale-document.ts)
-- only when the asset's whitepaper is approved by the Serbian Securities
-- Commission (whitepaper_status = 'ssc_approved' with ssc_decision_ref, 0026)
-- OR an offering exemption is recorded here: counsel's reference and the
-- reason (e.g. the ZDI art. 17(2) private-placement limits). Recording one is
-- a super-admin decision through /api/profiles/upsert, which also stamps who
-- and when; the four columns are set together or cleared together. Test
-- networks never read them (lib/whitepaper-approval.ts offeringClearance).
--
-- EXPAND only: four nullable columns and a CHECK that every existing row
-- (all NULL) satisfies. asset_profiles stays service-role only (0044), and
-- the public projection (lib/profile-public.ts) does not list these columns,
-- so they are never public.
--
-- Order: apply before or together with the front that reads them. The front
-- deployed today never selects or writes them; the new front selects them
-- only on mainnet and writes them only when an admin records or clears an
-- exemption, so devnet keeps working if the front ships first. Rows an older
-- front might write on devnet are harmless: only mainnet reads the columns.
begin;
set local lock_timeout = '15s';

alter table public.asset_profiles
  add column if not exists offering_exemption_ref text,
  add column if not exists offering_exemption_reason text,
  add column if not exists offering_exemption_recorded_by text,
  add column if not exists offering_exemption_recorded_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'asset_profiles_offering_exemption_complete'
      and conrelid = 'public.asset_profiles'::regclass
  ) then
    alter table public.asset_profiles
      add constraint asset_profiles_offering_exemption_complete check (
        (offering_exemption_ref is null and offering_exemption_reason is null
          and offering_exemption_recorded_by is null and offering_exemption_recorded_at is null)
        or (offering_exemption_ref is not null and offering_exemption_reason is not null
          and offering_exemption_recorded_by is not null and offering_exemption_recorded_at is not null)
      );
  end if;
end;
$$;

comment on column public.asset_profiles.offering_exemption_ref is
  'Mainnet: counsel''s reference for an offering that may run without an SSC-approved whitepaper (lansiranje-2). Set with _reason by the super admin via /api/profiles/upsert; never public.';
comment on column public.asset_profiles.offering_exemption_reason is
  'Mainnet: why the offering needs no approved whitepaper, as counsel states it. Set together with offering_exemption_ref.';
comment on column public.asset_profiles.offering_exemption_recorded_by is
  'Wallet (super admin) that recorded the exemption; stamped by the server.';
comment on column public.asset_profiles.offering_exemption_recorded_at is
  'When the exemption was recorded; stamped by the server.';

commit;
