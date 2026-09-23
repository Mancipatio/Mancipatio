-- 0068: CustodyVault v2 (program package 2C-3) appends `kyc_registry`: the
-- KYC registry a DeliveryEscrow pins at open. Its realize (the holder's
-- equity conversion or physical delivery) requires the beneficiary's
-- Approved, unexpired, jurisdiction-allowed KycEntry in that registry.
-- EXPAND step: the indexer mirror gets the column (null for vault types that
-- pin none).
--
-- Apply BEFORE the front that projects it is deployed:
-- apply_indexer_snapshot (0047) raises on any decoded column the table lacks.
-- Devnet had no CustodyVault accounts when v2 shipped; any stale v1 mirror
-- row is not on chain and is removed by the next reconcile.
begin;
set local lock_timeout = '15s';

alter table public.custody_vaults
  add column if not exists kyc_registry text;

comment on column public.custody_vaults.kyc_registry is
  'KYC registry pinned at open (DeliveryEscrow only; null otherwise). realize_custody_vault checks the beneficiary''s KycEntry in it (CustodyVault v2).';

commit;
