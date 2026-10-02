-- Read-only status of the automatic EUR rate (0080). Public prices, states and codes only.
--   MANCI_TARGET=devnet bash scripts/db.sh -f scripts/ops/fx-scheduler-status.sql
--   MANCI_TARGET=mainnet MANCI_ALLOW_MAINNET=1 bash scripts/db.sh -f scripts/ops/fx-scheduler-status.sql
begin read only;
select jobid,jobname,username,schedule,active,
  command='set statement_timeout=''30s''; select mancipatio_ops.invoke_fx_refresh();' as command_ok
from cron.job where jobname='mancipatio-fx-'||public.deployment_network();
select id,requested_at,duration_ms,http_status,ok,outcome,refresh_state,code
from mancipatio_ops.fx_http_runs order by requested_at desc limit 20;
select outcome,refresh_state,code,count(*) as runs
from mancipatio_ops.fx_http_runs where requested_at>now()-interval '1 hour'
group by outcome,refresh_state,code order by runs desc;
-- The automatic rate, its age and the evidence it was accepted on (the ECB
-- deviation next to the band the run allowed for the fix's age).
select payment_mint,eur_per_token,decimals,as_of,now()-as_of as age,max_age,(now()-as_of)<=max_age as fresh,source,
  quotes->'sources' as sources,quotes->'ecb' as ecb,quotes->>'spread_bps' as spread_bps,quotes->>'ecb_deviation_bps' as ecb_deviation_bps,
  quotes->>'ecb_tolerance_bps' as ecb_tolerance_bps
from public.fx_auto_rates where network=public.deployment_network() order by payment_mint;
select observed_at,payment_mint,status,code,eur_per_token,
  quotes->>'ecb_deviation_bps' as ecb_deviation_bps,quotes->>'ecb_tolerance_bps' as ecb_tolerance_bps
from public.fx_rate_observations where network=public.deployment_network() order by observed_at desc limit 15;
-- The manual rows (fallback or override) and the rate that counts per mint.
-- (Check `fresh` here before the off switch: from then on the manual row counts.)
select payment_mint,kind,eur_per_token,as_of,max_age,override_auto,source,
  kind='eur_peg' or as_of>=now()-max_age as fresh
from public.fx_rates where network=public.deployment_network() order by payment_mint;
select m.payment_mint,e.kind,e.eur_per_token,e.as_of,e.max_age,
  case when e.updated_by='fx-auto' then 'auto' when e.override_auto then 'manual_override' else 'manual' end as origin,
  e.kind='eur_peg' or e.as_of>=now()-e.max_age as fresh
from (select payment_mint from public.fx_rates where network=public.deployment_network()
      union select payment_mint from public.fx_auto_rates where network=public.deployment_network()) m
cross join lateral public.fx_effective_rate(public.deployment_network(),m.payment_mint) e
order by m.payment_mint;
select status,count(*) as runs from cron.job_run_details
where jobid in (select jobid from cron.job where jobname='mancipatio-fx-'||public.deployment_network())
  and start_time>now()-interval '1 day' group by status;
rollback;
