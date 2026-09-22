-- Admins can adjust an application's raise amount / equity case by case
-- (/api/applications/adjust-terms); record it in the application timeline.
begin;
alter table public.application_events drop constraint if exists application_events_action_check;
alter table public.application_events add constraint application_events_action_check
  check (action in ('submitted', 'resubmitted', 'approved', 'rejected', 'needs_changes', 'terms_adjusted'));
-- Default max equity matches the /apply slider the platform shipped with (30%);
-- only rows no admin has edited yet are aligned.
alter table public.platform_raise_limits alter column max_equity_percent set default 30;
update public.platform_raise_limits set max_equity_percent = 30 where updated_by is null and max_equity_percent = 100;
commit;
