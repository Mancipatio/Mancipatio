// The deadlines and bounds the v1.0.0-rc (8.3) program enforces, mirrored so
// a page refuses a value that must fail before the wallet opens. The program
// is the authority (its own clock); tests/deadline-bounds.test.ts pins every
// constant against program/programs/asset_registry/src/constants.rs.

/** `MAX_SALE_DURATION_SECS`: a sale ends at most 365 days after max(start, now). */
export const MAX_SALE_DURATION_SECONDS = 31_536_000;
/** `OTC_DEAL_MAX_TTL_SECS`: an OTC deal expires at most 90 days out. */
export const OTC_DEAL_MAX_TTL_SECONDS = 7_776_000;
/** `MAX_KYC_VALIDITY_SECS`: a passport is valid for at most 2 years. */
export const MAX_KYC_VALIDITY_SECONDS = 63_072_000;
/** `DELIVERY_ESCROW_MIN_DEADLINE_SECS` / `..._MAX_...`: 24 hours to 365 days. */
export const DELIVERY_ESCROW_MIN_DEADLINE_SECONDS = 86_400;
export const DELIVERY_ESCROW_MAX_DEADLINE_SECONDS = 31_536_000;
/** `MIN_VAULT_VOTING_PERIOD_SECS`: a payout-vault vote runs at least 7 days. */
export const MIN_VAULT_VOTING_PERIOD_SECONDS = 604_800;

/**
 * Why `open_sale` would refuse this end (SaleDurationInvalid 6145 /
 * InvalidSaleParams), or null. `endTs` 0 means "no end", which v1 refuses.
 */
export function saleEndError(
  startTs: bigint,
  endTs: bigint,
  nowSec: bigint = BigInt(Math.floor(Date.now() / 1000)),
): string | null {
  if (endTs <= BigInt(0)) return "Choose an end date: every sale ends, at most 365 days out.";
  if (endTs <= startTs) return "The sale must end after it starts.";
  const latest = (startTs > nowSec ? startTs : nowSec) + BigInt(MAX_SALE_DURATION_SECONDS);
  if (endTs > latest) return "A sale can run for at most 365 days (from its start, or from now if it already started).";
  return null;
}

/** `create_otc_deal`'s expiry, clamped into (now, now + 90 days]. */
export function clampDealExpiry(expiresAt: bigint, nowSec: bigint): bigint {
  const latest = nowSec + BigInt(OTC_DEAL_MAX_TTL_SECONDS);
  return expiresAt > latest ? latest : expiresAt;
}
