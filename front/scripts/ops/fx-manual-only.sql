-- Rollback of the automatic EUR rate (migration 0080), runbook §15
-- "Rollback": optional, AFTER the off switch (scripts/ops/fx-auto-off.sql).
-- Through db.sh (which asserts the target first):
--   MANCI_TARGET=<t> bash scripts/db.sh -f scripts/ops/fx-manual-only.sql
-- (mainnet also needs MANCI_ALLOW_MAINNET=1).
--
-- public.fx_effective_rate then returns the manual fx_rates row only (the
-- 0066 behaviour), whatever fx_auto_rates holds; the five ledger functions
-- keep calling it. The tables, the override_auto column and the writers stay,
-- and the function keeps its grants (create or replace). A file, not
-- db.sh -c "...": the shell would expand the function's $$ body.
-- Undo: re-apply supabase/migrations/0080_fx_auto_rates.sql (re-runnable).

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
end;
$$;

create or replace function public.fx_effective_rate(p_network text, p_payment_mint text)
returns setof public.fx_rates language sql stable security definer set search_path = '' as $$
  select * from public.fx_rates where network = p_network and payment_mint = p_payment_mint
$$;
comment on function public.fx_effective_rate(text, text) is
  'Manual-only (rollback of 0080, scripts/ops/fx-manual-only.sql): the fx_rates row of the mint. Re-apply 0080 to bring the automatic rate back.';

commit;
