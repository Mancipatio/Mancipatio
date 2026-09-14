-- 0029: wallet-only Terms-of-Service acceptance (P1, W2-F2).
--
-- ============================================================================
-- APPLY ORDER: this migration MUST land BEFORE (or in the same deploy window
-- as) the front build that ships the ToS interstitial (components/tos-gate.tsx).
-- Rationale: once the front deploys, the gate arms for EVERY connected wallet,
-- and /api/tos/accept inserts a row with client_id = NULL for wallet-only
-- acceptances. While client_id is still NOT NULL (0016 state), that insert
-- raises 23502 and the wallet is stuck behind a modal it cannot dismiss. Note
-- this is the OPPOSITE ordering constraint from 0025 (apply AFTER the front) —
-- apply 0029 first / with the front, and 0025 last, all in one deploy window.
-- (The gate also has a client-side fail-open escape as a backstop.)
-- ============================================================================
--
-- The marketplace/portfolio ToS interstitial records acceptance for any
-- connected wallet — including wallets that have NO clients row (no onboarding
-- yet). Until now tos_acceptances.client_id was NOT NULL (0016), which made
-- wallet-only rows impossible.
--
--   * client_id becomes nullable (FK to clients kept; onboarding acceptances
--     still link the client row, wallet-only acceptances leave it NULL).
--   * wallet column already exists since 0016 — the ADD COLUMN below is a
--     no-op on the live database and only matters for fresh installs.
--   * (wallet, version) index backs the interstitial's per-wallet lookup
--     (lib/tos.ts) and the signed /api/tos/accept route (W2-SD1).

alter table public.tos_acceptances
  alter column client_id drop not null;

alter table public.tos_acceptances
  add column if not exists wallet text;

create index if not exists tos_acceptances_wallet_version_idx
  on public.tos_acceptances (wallet, version);
