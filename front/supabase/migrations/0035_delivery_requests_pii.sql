-- 0035_delivery_requests_pii.sql — lock down delivery_requests reads.
--
-- ============================================================================
-- APPLY ONLY AFTER deploying the front that reads delivery_requests through
-- the signed routes /api/delivery/list-mine (holder, bound to the signer) and
-- /api/delivery/admin-list (requireAdmin). Applying early breaks the holder
-- delivery page and the admin custody queue.
-- ============================================================================
--
-- 0025 kept `delivery_requests anon read` (using(true)) because the holder
-- portfolio page and the admin custody queue read the table directly with the
-- anon key. Those rows carry the holder's PHYSICAL delivery address
-- (delivery_details) and contact (email/phone) — the same PII class that
-- conversion_requests (0034) and passport_requests (0031) were locked behind
-- signed reads. This finishes that pass for delivery: reads now go through the
-- two signed routes above (service role bypasses RLS), so the anon SELECT can
-- be dropped, matching the conversion posture.

do $$
declare
  pol record;
begin
  for pol in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'delivery_requests'
      and cmd = 'SELECT'
  loop
    execute format(
      'drop policy %I on public.delivery_requests', pol.policyname
    );
  end loop;
end $$;

-- Default-deny for anon/authenticated; only the service-role delivery routes
-- (create / cancel / deposited / reclaim / list-mine / admin-list /
-- admin-update) touch the table. RLS stays enabled from 0025.
alter table public.delivery_requests enable row level security;
