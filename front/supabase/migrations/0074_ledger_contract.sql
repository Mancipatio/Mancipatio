-- 0074 (Talas 5.1): CONTRACT step of the ledger. Apply only after the front
-- from the same release (no browser read of spv_issuances, no call of
-- record_spv_issuance) has been live for at least a day (design §10.5).
-- Until then the previous front still reads spv_issuances with the anon key
-- and books manual rows through record_spv_issuance.
--
--   - drop the anonymous read policy on spv_issuances (0031) and every
--     browser-role grant: the issuance ledger is read through the signed
--     routes /api/spvs/capacity and /api/spvs/issuances (D15);
--   - drop record_spv_issuance: manual rows go through
--     record_spv_adjustment (0073).
--
-- Rollback (not a migration): recreate the policy
--   create policy "spv_issuances anon read" on public.spv_issuances for select using (true);
--   grant select on public.spv_issuances to anon, authenticated;
-- and re-apply record_spv_issuance from 0073 (section 15).
--
-- Re-runnable.
begin;
set local lock_timeout = '15s';

drop policy if exists "spv_issuances anon read" on public.spv_issuances;
revoke all on public.spv_issuances from anon, authenticated;
revoke all on sequence public.spv_issuances_id_seq from anon, authenticated;
grant all on public.spv_issuances to service_role;

drop function if exists public.record_spv_issuance(uuid, numeric, text, text, date, text, text, boolean, boolean);

notify pgrst, 'reload schema';

commit;
