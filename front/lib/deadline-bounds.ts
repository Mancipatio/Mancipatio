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

// ── Conversion escrow deadline (/admin/custody Approve dialog) ─────────────
// The program only bounds a DeliveryEscrow deadline to 24 h..365 d (6148).
// What the deadline MEANS for a conversion is operational: the escrow waits
// for the notary and the APR decision before the burn, and after the deadline
// `return_custody_vault` is permissionless — anyone can hand the escrow back
// to the holder, even once the shares are registered. The runbook therefore
// asks for 120–180 days; the dialog proposes 150 and warns below 120. Neither
// is enforced here: the operator decides, the program bounds.

/** The deadline the Approve dialog proposes for a conversion escrow. */
export const DEFAULT_CONVERSION_DEADLINE_DAYS = 150;
/** Below this the dialog warns (the runbook's floor; a recommendation only). */
export const MIN_CONVERSION_DEADLINE_DAYS = 120;

const DAY_MS = 86_400_000;

/** The `datetime-local` value of now + DEFAULT_CONVERSION_DEADLINE_DAYS. */
export function conversionDeadlineDefault(nowMs: number = Date.now()): string {
  return toDatetimeLocalValue(new Date(nowMs + DEFAULT_CONVERSION_DEADLINE_DAYS * DAY_MS));
}

export const CONVERSION_DEADLINE_SHORT_WARNING =
  "The runbook recommends 120–180 days: escrow usually waits for the notary and the APR decision; after the deadline anyone can return the tokens to the holder.";

/**
 * An advisory warning for a conversion deadline the program would accept, or
 * null: under MIN_CONVERSION_DEADLINE_DAYS, or past the holder's passport
 * expiry (the burn needs a current passport, so it is refused after that
 * date until the passport is renewed). Null while deliveryDeadlineError
 * reports the value (the error shows instead). Never blocks the open.
 */
export function conversionDeadlineWarning(
  value: string,
  opts: { nowMs?: number; passportExpirySec?: bigint | null } = {},
): string | null {
  const nowMs = opts.nowMs ?? Date.now();
  if (deliveryDeadlineError(value, nowMs) !== null) return null;
  const t = new Date(value).getTime();
  if (t < nowMs + MIN_CONVERSION_DEADLINE_DAYS * DAY_MS) return CONVERSION_DEADLINE_SHORT_WARNING;
  const expiry = opts.passportExpirySec ?? null;
  if (expiry !== null && expiry > BigInt(0) && Number(expiry) * 1000 < t) {
    const day = new Date(Number(expiry) * 1000).toISOString().slice(0, 10);
    return `The holder's passport expires on ${day}, before this deadline: the burn is refused after that date until the passport is renewed.`;
  }
  return null;
}

export type CustodyDeadlineUrgency = {
  level: "ok" | "soon" | "urgent" | "passed";
  /** Whole days until the deadline; 0 once it has passed. */
  daysLeft: number;
};

/** Within this many days a custody deadline is "soon", and under this "urgent". */
export const CUSTODY_DEADLINE_SOON_DAYS = 30;
export const CUSTODY_DEADLINE_URGENT_DAYS = 7;

/**
 * How close a custody vault's deadline (unix seconds) is: null for a vault
 * without one (0), "passed" once now is at or past it, "urgent" under 7
 * days, "soon" under 30, otherwise "ok". After the deadline the escrow is
 * returnable by anyone, so the queue colours the rows that near it.
 */
export function custodyDeadlineUrgency(deadlineSec: bigint, nowSec: number): CustodyDeadlineUrgency | null {
  if (deadlineSec <= BigInt(0)) return null;
  const left = Number(deadlineSec) - nowSec;
  if (left <= 0) return { level: "passed", daysLeft: 0 };
  const daysLeft = Math.floor(left / 86_400);
  if (daysLeft < CUSTODY_DEADLINE_URGENT_DAYS) return { level: "urgent", daysLeft };
  if (daysLeft < CUSTODY_DEADLINE_SOON_DAYS) return { level: "soon", daysLeft };
  return { level: "ok", daysLeft };
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
