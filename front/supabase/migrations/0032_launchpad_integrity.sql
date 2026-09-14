-- 0032_launchpad_integrity.sql — commitments settled_tx uniqueness
--
-- One on-chain transaction signature may back AT MOST ONE commitment row.
-- Without this, a single real `buy` tx could be replayed into unlimited
-- "settled" rows, inflating a sale's public raised/backers aggregate.
-- The /api/launchpad/record-purchase and /api/launchpad/commitment-status
-- routes now verify settled_tx on-chain AND pre-check uniqueness; this index
-- closes the remaining insert/update race at the database layer.
--
-- Partial (settled_tx IS NOT NULL): pending soft commitments carry NULL.
--
-- Guarded: if historical duplicate settled_tx values already exist, creating
-- the index would make the whole migration fail — instead we raise a warning
-- and skip, so applying is always safe. Dedupe (keep the oldest row per
-- signature, delete or NULL the rest) and re-apply to get the constraint.

do $$
begin
  if exists (
    select 1
    from public.commitments
    where settled_tx is not null
    group by settled_tx
    having count(*) > 1
  ) then
    raise warning
      '0032: duplicate settled_tx values exist in public.commitments — dedupe them, then re-apply to create commitments_settled_tx_key';
  else
    create unique index if not exists commitments_settled_tx_key
      on public.commitments (settled_tx)
      where settled_tx is not null;
  end if;
end $$;
