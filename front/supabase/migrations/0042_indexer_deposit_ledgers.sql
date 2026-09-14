-- 0042 — deposit ledgers in the indexer mirrors.
--
-- The asset_registry program grew a deposit ledger on two indexed accounts:
--
--   * Offer.deposited          — units the MAKER put into the offer escrow
--                                through `deposit_to_offer_escrow`;
--   * CustodyVault.deposited   — units the BENEFICIARY put into the custody
--                                escrow through `deposit_to_custody_vault`.
--
-- Both are appended at the END of their account structs, so the existing byte
-- layout (and every prefix decoder) is unchanged; only the accounts got 8
-- bytes longer. The ledger — not the escrow's token balance — is what the
-- program pays refunds against and what `take_offer` requires, so the mirrors
-- have to carry it or any query built on them answers the wrong question.
--
-- DEPLOY ORDER (see the header of supabase/functions/helius-webhook/index.ts):
-- apply this migration BEFORE deploying the webhook build that writes these
-- columns. A webhook that writes a column PostgREST does not know about gets
-- PGRST204, which the function treats exactly like a missing table: retriable
-- while the transaction is fresh, then skipped so the pipeline cannot wedge.
--
-- Backfill: existing rows default to 0, which is the truth for every account
-- created before the upgrade (nothing was ever recorded). Rows for accounts
-- that DO carry a non-zero ledger are refreshed by the next transaction that
-- touches the PDA, or immediately by /api/admin/reconcile.

alter table public.offers
  add column if not exists deposited numeric not null default 0;

alter table public.custody_vaults
  add column if not exists deposited numeric not null default 0;
