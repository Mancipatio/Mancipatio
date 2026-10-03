-- Rollback of the automatic EUR rate (migration 0080), runbook §15
-- "Rollback": optional, AFTER the whole off switch (scripts/ops/fx-auto-off.sql:
-- the job disabled AND the network's fx_auto_rates rows deleted; this file
-- refuses otherwise). Through db.sh (which asserts the target first):
--   MANCI_TARGET=devnet bash scripts/db.sh -f scripts/ops/fx-manual-only.sql
--   MANCI_TARGET=mainnet MANCI_ALLOW_MAINNET=1 bash scripts/db.sh -f scripts/ops/fx-manual-only.sql
--
-- public.fx_effective_rate then returns the manual fx_rates row only (the
-- 0066 behaviour), whatever fx_auto_rates holds; the five ledger functions
-- keep calling it. The tables, the override_auto column and the writers stay,
-- and the function keeps its grants (create or replace). Its comment starts
-- with the marker 'manci:fx-manual-only': fx-scheduler.sql refuses to install
-- while it is there (it also checks the body). A file, not db.sh -c "...":
-- the shell would expand the function's $$ body.
-- Undo (back on): re-apply supabase/migrations/0080_fx_auto_rates.sql
-- (re-runnable; it restores the resolver and its comment), then
-- fx-scheduler.sql, invoke_fx_refresh(), fx-scheduler-status.sql, enable.

begin;

do $$
declare running boolean := false;
begin
  if to_regprocedure('public.fx_effective_rate(text,text)') is null then
    raise exception 'Migration 0080 is not applied: nothing to roll back';
  end if;
  if to_regclass('cron.job') is not null then
    execute 'select exists (select 1 from cron.job where jobname = $1 and active)'
      into running using 'mancipatio-fx-' || public.deployment_network();
  end if;
  if running then
    raise exception 'The fx job is still active: run scripts/ops/fx-auto-off.sql first';
  end if;
  -- The whole off switch ran: no automatic row of this network is left.
  if to_regclass('public.fx_auto_rates') is not null then
    if exists (select 1 from public.fx_auto_rates where network = public.deployment_network()) then
      raise exception 'public.fx_auto_rates still holds this network''s automatic rates: run the whole off switch (scripts/ops/fx-auto-off.sql) first';
    end if;
  end if;
end;
$$;

create or replace function public.fx_effective_rate(p_network text, p_payment_mint text)
returns setof public.fx_rates language sql stable security definer set search_path = '' as $$
  select * from public.fx_rates where network = p_network and payment_mint = p_payment_mint
$$;
comment on function public.fx_effective_rate(text, text) is
  'manci:fx-manual-only. Rollback of 0080 (scripts/ops/fx-manual-only.sql): the fx_rates row of the mint only. Re-apply 0080 to bring the automatic rate back.';

commit;
