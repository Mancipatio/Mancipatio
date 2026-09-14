-- 0021: Payout airdrop execution (Flows doc: the issuer funds the contract and
-- the proportionate amount is pushed to each holder wallet). Adds the payment
-- mint metadata needed to execute batched transfers plus per-recipient error slots.

alter table public.payouts
  add column if not exists payment_mint text,
  add column if not exists payment_decimals integer not null default 6,
  add column if not exists airdrop_started_at timestamptz,
  add column if not exists airdrop_completed_at timestamptz;

alter table public.payout_recipients
  add column if not exists send_error text;
