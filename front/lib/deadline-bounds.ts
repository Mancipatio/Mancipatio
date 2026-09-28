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
 * The program caps the end at max(start, ITS now) + 365 days: when the sale
 * starts now (or already started) the cap keeps CHAIN_CLOCK_MARGIN_SECONDS
 * below the browser's, since the chain clock can lag it; a future start is
 * exact. An end already in the past is refused too (a sale nobody can buy).
 */
export function saleEndError(
  startTs: bigint,
  endTs: bigint,
  nowSec: bigint = BigInt(Math.floor(Date.now() / 1000)),
): string | null {
  if (endTs <= BigInt(0)) return "Choose an end date: every sale ends, at most 365 days out.";
  if (endTs <= startTs) return "The sale must end after it starts.";
  if (endTs <= nowSec) return "The sale end date must be in the future.";
  const margin = BigInt(CHAIN_CLOCK_MARGIN_SECONDS);
  const from = startTs > nowSec - margin ? startTs : nowSec - margin;
  const latest = from + BigInt(MAX_SALE_DURATION_SECONDS);
  if (endTs > latest) return "A sale can run for at most 365 days (from its start, or from now if it already started).";
  return null;
}

/**
 * Kept clear of a bound the program judges on ITS clock whenever the front
 * picks the value itself (a clamp, a default) or the value sits right at the
 * edge: the chain clock can run tens of seconds behind the browser's, and the
 * transaction lands after the signature. Ten minutes covers both, so a value
 * the page accepts is not one the program must refuse.
 */
export const CHAIN_CLOCK_MARGIN_SECONDS = 600;

/**
 * `create_otc_deal`'s expiry, clamped into (now, now + 90 days − margin]: a
 * clamp at exactly now + 90 days would be refused (6149) whenever the chain
 * clock lags the browser's.
 */
export function clampDealExpiry(expiresAt: bigint, nowSec: bigint): bigint {
  const latest = nowSec + BigInt(OTC_DEAL_MAX_TTL_SECONDS - CHAIN_CLOCK_MARGIN_SECONDS);
  return expiresAt > latest ? latest : expiresAt;
}

/**
 * Why `create_otc_deal` would refuse this expiry (DealExpiryOutOfRange 6149:
 * `now < expires_at ≤ now + 90 days`), or null. Checked right before the
 * admin signs.
 */
export function dealExpiryError(
  expiresAt: bigint,
  nowSec: bigint = BigInt(Math.floor(Date.now() / 1000)),
): string | null {
  if (expiresAt <= nowSec) return "The deal expiry must be in the future.";
  if (expiresAt > nowSec + BigInt(OTC_DEAL_MAX_TTL_SECONDS))
    return "An OTC deal can run for at most 90 days: choose an earlier expiry.";
  return null;
}

/**
 * Why a DeliveryEscrow deadline (a `datetime-local` value) would be refused
 * (DeliveryDeadlineOutOfRange 6148: `now + 24 h ≤ deadline ≤ now + 365 d`),
 * or null. Both bounds keep the clock margin, since the program's `now` is
 * the chain's at landing time.
 */
export function deliveryDeadlineError(value: string, nowMs: number = Date.now()): string | null {
  if (!value.trim()) return "Deadline is required";
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return "Not a valid date";
  const margin = CHAIN_CLOCK_MARGIN_SECONDS * 1000;
  if (t < nowMs + DELIVERY_ESCROW_MIN_DEADLINE_SECONDS * 1000 + margin)
    return "Deadline must be at least 24 hours from now";
  if (t > nowMs + DELIVERY_ESCROW_MAX_DEADLINE_SECONDS * 1000 - margin)
    return "Deadline must be at most 365 days from now";
  return null;
}

/**
 * Why `approve_holder` would refuse this passport expiry (`expiry > now`,
 * InvalidExpiry; `expiry ≤ now + 2 years`, KycExpiryTooFar 6146), or null.
 */
export function kycExpiryError(expirySec: bigint, nowSec: bigint): string | null {
  if (expirySec <= nowSec) return "The passport expiry must be in the future.";
  if (expirySec > nowSec + BigInt(MAX_KYC_VALIDITY_SECONDS))
    return "A passport can be valid for at most 2 years from today.";
  return null;
}

/**
 * The on-chain passport expiry for a verified client: the stored off-chain
 * verdict expiry while it is in the future, else the policy window, capped
 * at 2 years minus the clock margin (6146).
 */
export function passportExpirySeconds(
  storedExpiryIso: string | null | undefined,
  nowSec: number,
  policyDays: number,
): number {
  const stored = storedExpiryIso ? Math.floor(new Date(storedExpiryIso).getTime() / 1000) : 0;
  const wanted = Number.isFinite(stored) && stored > nowSec ? stored : nowSec + policyDays * 86_400;
  return Math.min(wanted, nowSec + MAX_KYC_VALIDITY_SECONDS - CHAIN_CLOCK_MARGIN_SECONDS);
}

/** A Date as a `datetime-local` input value (local time, minute precision). */
export function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The default sale length when the form opens (the issuer can change it). */
export const DEFAULT_SALE_DAYS = 30;

/**
 * The `datetime-local` bounds of a sale's (required) end date when it starts
 * now: min an hour out, max 365 days minus the chain-clock margin (rounded
 * down to the minute), and the default DEFAULT_SALE_DAYS out.
 */
export function saleEndInputBounds(nowMs: number = Date.now()): { min: string; max: string; defaultValue: string } {
  const maxMs = Math.floor((nowMs + (MAX_SALE_DURATION_SECONDS - CHAIN_CLOCK_MARGIN_SECONDS) * 1000) / 60_000) * 60_000;
  return {
    min: toDatetimeLocalValue(new Date(nowMs + 3_600_000)),
    max: toDatetimeLocalValue(new Date(maxMs)),
    defaultValue: toDatetimeLocalValue(new Date(nowMs + DEFAULT_SALE_DAYS * 86_400_000)),
  };
}
