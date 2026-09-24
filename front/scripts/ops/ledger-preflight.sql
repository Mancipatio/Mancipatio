-- Read-only ledger preflight before migration 0073 (Talas 5.1, design §7).
--   MANCI_TARGET=<t> bash scripts/db.sh -f scripts/ops/ledger-preflight.sql
-- A human decides on every row listed before 0073 is applied:
--   1. duplicate source='sale' rows of one (SPV, sale): 0073 refuses to run
--      (SPV_SALE_DUPLICATES) until they are merged;
--   2. manual rows whose sale_pubkey or asset_pda is a sale (a reservation's
--      sale_pda or a source='sale' row's sale_pubkey): probably the same sale
--      booked twice (by hand and by the server);
--   3. manual rows on assets that have server bookings in the last 12 months:
--      possibly the same issuance.
-- Nothing is changed.
begin read only;

\echo '1. Duplicate sale bookings (block 0073)'
select spv_id, sale_pubkey, count(*) as rows, sum(amount_eur) as total_eur, array_agg(id order by id) as ids
from public.spv_issuances
where source = 'sale' and sale_pubkey is not null
group by spv_id, sale_pubkey having count(*) > 1
order by spv_id, sale_pubkey;

\echo '2. Manual rows that name a sale'
select i.id, i.spv_id, i.issued_at, i.amount_eur, i.asset_pda, i.sale_pubkey, i.recorded_by
from public.spv_issuances i
join public.spvs s on s.id = i.spv_id
where i.source = 'manual'
  and (exists (select 1 from public.sale_capacity_reservations r
                where r.network = s.network and r.sale_pda is not null and r.sale_pda in (i.sale_pubkey, i.asset_pda))
    or exists (select 1 from public.spv_issuances x
                where x.source = 'sale' and x.sale_pubkey is not null and x.sale_pubkey in (i.sale_pubkey, i.asset_pda))
    or exists (select 1 from public.sales z where z.network = s.network and z.pda in (i.sale_pubkey, i.asset_pda)))
order by i.issued_at desc;

\echo '3. Manual rows on assets with server bookings in the last 12 months'
select i.id, i.spv_id, i.issued_at, i.amount_eur, i.asset_pda,
  (select jsonb_agg(jsonb_build_object('id', x.id, 'issued_at', x.issued_at, 'amount_eur', x.amount_eur, 'source', x.source)
     order by x.issued_at) from public.spv_issuances x
    where x.spv_id = i.spv_id and x.asset_pda = i.asset_pda and x.source in ('sale', 'treasury_mint')
      and x.issued_at > current_date - interval '12 months') as server_bookings
from public.spv_issuances i
where i.source = 'manual' and i.asset_pda is not null and i.issued_at > current_date - interval '12 months'
  and exists (select 1 from public.spv_issuances x
               where x.spv_id = i.spv_id and x.asset_pda = i.asset_pda and x.source in ('sale', 'treasury_mint')
                 and x.issued_at > current_date - interval '12 months')
order by i.issued_at desc;

rollback;
