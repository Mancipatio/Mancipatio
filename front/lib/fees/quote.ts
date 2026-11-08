// What a fee costs, and how it reads. Pure: no I/O, importable from the
// server, the admin console, the public pages and the quote surfaces. The
// charge route prices every charge with quoteFee and the public pages
// describe the same row with describeFee, so what a client is shown before
// committing is what Manci invoices.
//
//   quote = max(min, fixed x quantity + base x rate), then capped by max
//
// Money is computed in integer euro cents with BigInt (a EUR 1bn base times
// 10,000 bps is past a double's exact range) and rounded once, half up to
// the cent, on the rate part. quantity is 1 except for a per-unit fee
// (migration_per_holder: EUR x per delivered holder wallet). Inputs that are
// not exact cent amounts are refused rather than rounded: a price must never
// change silently between the screen and the invoice.

import { FEE_KIND_BASE, FEE_KIND_UNIT, isPerUnitKind, type FeeTerms } from "@/lib/fees/schedule";

// BigInt constants (the build targets ES2017: no BigInt literals).
const ZERO = BigInt(0);
const CENT = BigInt(100);
const BPS = BigInt(10_000);
const HALF_BPS = BigInt(5_000);

/** The largest amount a charge can record: numeric(12,2) in 0089. */
export const MAX_CHARGE_CENTS = BigInt("999999999999");

export type FeeQuote = {
  /** The amount in euro cents (an integer). */
  cents: number;
  /** The amount in euros (cents / 100). */
  eur: number;
  /** Which rule set the amount: the formula itself, the minimum or the maximum. */
  basis: "formula" | "minimum" | "maximum";
  /** fixed x quantity + base x rate, before the minimum and maximum (cents). */
  formulaCents: number;
};

const AMOUNT_RE = /^(\d{1,12})(?:\.(\d{1,2}))?$/;

/**
 * Exact euro cents of a non-negative amount with at most two decimals, as a
 * number (what PostgREST answers for numeric) or a decimal string. Throws a
 * RangeError for anything else, including a number with more decimals.
 */
export function eurToCents(value: number | string): bigint {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`Not a EUR amount: ${value}`);
    text = value.toFixed(2);
    // A number with more than two decimals does not survive the round trip.
    if (Number(text) !== value) throw new RangeError(`A EUR amount has at most two decimals: ${value}`);
  } else {
    text = value.trim();
  }
  const match = AMOUNT_RE.exec(text);
  if (!match) throw new RangeError(`Not a EUR amount: ${String(value)}`);
  return BigInt(match[1]) * CENT + BigInt((match[2] ?? "").padEnd(2, "0"));
}

/** Cents as canonical decimal text, "1234.50" (what a numeric(12,2) column takes). */
export function centsToDecimal(cents: number | bigint): string {
  const value = BigInt(cents);
  if (value < ZERO) throw new RangeError("A fee is never negative");
  return `${value / CENT}.${String(value % CENT).padStart(2, "0")}`;
}

function toCents(value: number | string | null): bigint | null {
  return value === null ? null : eurToCents(value);
}

function checkTerms(terms: FeeTerms): { fixed: bigint; min: bigint | null; max: bigint | null } {
  if (!Number.isInteger(terms.rate_bps) || terms.rate_bps < 0 || terms.rate_bps > 10_000) {
    throw new RangeError("rate_bps must be an integer between 0 and 10000");
  }
  const fixed = eurToCents(terms.fixed_eur);
  const min = toCents(terms.min_eur);
  const max = toCents(terms.max_eur);
  if (min !== null && max !== null && min > max) throw new RangeError("The minimum exceeds the maximum");
  return { fixed, min, max };
}

/**
 * The fee for `baseEur` (the value the rate applies to, e.g. the conversion
 * value; 0 when the fee has no rate) and `quantity` units of a per-unit fee.
 * Throws a RangeError for malformed terms or inputs, and when the amount is
 * larger than a charge can record.
 */
export function quoteFee(terms: FeeTerms, baseEur: number | string, quantity = 1): FeeQuote {
  const { fixed, min, max } = checkTerms(terms);
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new RangeError("quantity must be a positive integer");
  if (quantity !== 1 && !isPerUnitKind(terms.kind)) throw new RangeError("Only a per-unit fee takes a quantity");
  const base = eurToCents(baseEur);
  // base (cents) x bps / 10,000, half up: the only rounding in the quote.
  const variable = (base * BigInt(terms.rate_bps) + HALF_BPS) / BPS;
  const formula = fixed * BigInt(quantity) + variable;
  let cents = formula;
  let basis: FeeQuote["basis"] = "formula";
  if (min !== null && cents < min) {
    cents = min;
    basis = "minimum";
  }
  if (max !== null && cents > max) {
    cents = max;
    basis = "maximum";
  }
  if (cents > MAX_CHARGE_CENTS || formula > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("The fee exceeds the largest amount a charge can record");
  }
  return { cents: Number(cents), eur: Number(cents) / 100, basis, formulaCents: Number(formula) };
}

const EUR_FORMAT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const EUR_FORMAT_CENTS = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "EUR 2,500", or "EUR 2,500.50" when there are cents. Locale-independent. */
export function formatEurCents(cents: number | bigint): string {
  const value = BigInt(cents);
  if (value < ZERO) throw new RangeError("A fee is never negative");
  const whole = value / CENT;
  const rest = value % CENT;
  // Intl formats the whole part exactly below 2^53, far above any fee.
  return rest === ZERO
    ? `EUR ${EUR_FORMAT.format(Number(whole))}`
    : `EUR ${EUR_FORMAT_CENTS.format(Number(value) / 100)}`;
}

/** formatEurCents of an amount in euros (number or decimal string). */
export function formatEur(value: number | string): string {
  return formatEurCents(eurToCents(value));
}

/** "1 %", "1.5 %", "0.25 %" for basis points (the house style of the price list). */
export function formatRateBps(bps: number): string {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new RangeError("rate_bps must be an integer between 0 and 10000");
  const percent = (bps / 100).toFixed(2).replace(/\.?0+$/, "");
  return `${percent} %`;
}

/**
 * The public sentence for a fee's amount, e.g.
 *   "1 % of the conversion value, minimum EUR 150"
 *   "EUR 2,500"
 *   "EUR 2 per delivered holder wallet"
 *   "EUR 500 plus 1 % of the amount raised, maximum EUR 10,000"
 * A minimum that the fixed part already reaches is left out; a fee that can
 * only be zero reads "No charge".
 */
export function describeFee(terms: FeeTerms): string {
  const { fixed, min, max } = checkTerms(terms);
  const unit = FEE_KIND_UNIT[terms.kind];
  if (max === ZERO) return "No charge";
  if (fixed === ZERO && terms.rate_bps === 0) {
    // Neither part: the minimum alone is the price, else nothing is charged.
    return min !== null && min > ZERO ? formatEurCents(min) : "No charge";
  }
  if (unit === null && terms.rate_bps === 0) {
    // A flat amount is the price itself, held within its bounds.
    let flat = fixed;
    if (min !== null && flat < min) flat = min;
    if (max !== null && flat > max) flat = max;
    return formatEurCents(flat);
  }
  const parts: string[] = [];
  if (fixed > ZERO) parts.push(unit === null ? formatEurCents(fixed) : `${formatEurCents(fixed)} per ${unit}`);
  if (terms.rate_bps > 0) parts.push(`${formatRateBps(terms.rate_bps)} of ${FEE_KIND_BASE[terms.kind]}`);
  let text = parts.join(" plus ");
  if (min !== null && min > fixed) text += `, minimum ${formatEurCents(min)}`;
  if (max !== null) text += `, maximum ${formatEurCents(max)}`;
  return text;
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** "1 December 2026" for an effective date (UTC, so the server and the browser agree). */
export function formatFeeDate(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) throw new RangeError(`Not a date: ${iso}`);
  return DATE_FORMAT.format(new Date(at));
}

/** "When the request is approved" -> "when the request is approved", to continue a sentence. */
export function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
