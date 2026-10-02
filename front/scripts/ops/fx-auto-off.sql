-- Off switch of the automatic EUR rate (migration 0080), runbook §15
-- "Automatic EUR rate". Both halves, in one transaction, through db.sh
-- (which asserts the target first):
--   MANCI_TARGET=<t> bash scripts/db.sh -f scripts/ops/fx-auto-off.sql
-- (mainnet also needs MANCI_ALLOW_MAINNET=1).
--
--   1. disables 'mancipatio-fx-<network>': no new automatic rate;
--   2. deletes the network's fx_auto_rates rows: the manual fx_rates rows
--      count again at once (fx_effective_rate, lib/fx-effective.ts).
-- Either half alone is not off: a disabled job leaves a fresh automatic rate
-- counting for up to 15 minutes, and deleted rows come back with the next
-- run of a job still enabled.
--
-- The observations stay (the audit trail, kept 30 days). With no automatic
-- row and no run for 5 minutes the alarm worker treats the job as off:
-- fx-auto-stale and the other fx-* incidents pass from then on. The manual
-- USDC row must be fresh (kind rate, max age at most 7 days on mainnet),
-- else approvals refuse with FX_RATE_STALE: the last result set shows it.
-- Back on: fx-scheduler.sql's checks (invoke_fx_refresh, the status SQL),
-- then cron.alter_job(..., active := true).

begin;

do $$
begin
  if to_regclass('public.fx_auto_rates') is null then
    raise exception 'Migration 0080 is not applied: there is no automatic rate to switch off';
  end if;
end;
$$;

\o /dev/null
select cron.alter_job(jobid, active := false) from cron.job where jobname = 'mancipatio-fx-' || public.deployment_network();
\o
delete from public.fx_auto_rates where network = public.deployment_network();

commit;

select coalesce((select jobname || ' active=' || active from cron.job
                  where jobname = 'mancipatio-fx-' || public.deployment_network()), 'no fx job installed') as fx_job,
       (select count(*) from public.fx_auto_rates where network = public.deployment_network()) as automatic_rows_left;
select r.payment_mint, r.kind, r.eur_per_token, r.as_of, r.max_age, r.override_auto,
       r.kind = 'eur_peg' or r.as_of >= now() - r.max_age as fresh
  from public.fx_rates r where r.network = public.deployment_network() order by r.payment_mint;
