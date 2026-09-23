-- 0067: Sale v2 (program package 2B) appends `sale_approval` and
-- `application_hash` to the on-chain Sale. EXPAND step: the indexer mirror
-- gets the two columns (the approval PDA open_sale consumed, and the hex
-- commitment to the reviewed application).
--
-- Apply BEFORE the front that projects them is deployed:
-- apply_indexer_snapshot (0047) raises on any decoded column the table lacks.
-- Devnet had no Sale accounts when v2 shipped; any stale v1 mirror row is not
-- on chain and is removed by the next reconcile.
begin;
set local lock_timeout = '15s';

alter table public.sales
  add column if not exists sale_approval text,
  add column if not exists application_hash text;

comment on column public.sales.sale_approval is
  'SaleApproval PDA consumed (and closed) by open_sale (Sale v2).';
comment on column public.sales.application_hash is
  'Hex sha256 commitment to the reviewed application snapshot, copied from the approval (Sale v2).';

commit;
