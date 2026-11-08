// Token migration (V1): the exchange ratio of an existing token for units of
// a Manci share class. Pure and isomorphic (no React, no browser API, no
// server import): the admin calculator, the server routes, the public pages
// and the tests all compute the same numbers from the same function.
//
// Every amount is a bigint in BASE units: the old token has `decimals` d, so
// one whole old token is 10^d base units, and the share-class mint has 0
// decimals (one unit is an integer, `granularity` units are 100 % of the
// company). Nothing is ever rounded through a JavaScript number.
//
//   S_old    = oldTotalSupply − excludedAmount          (qualified supply, > 0)
//   N_target = floor(E × G / 10000)                     (units the shareholders' decision allows)
//   rawLot   = S_old / N_target                         (base units per unit, rational)
//   L        = smallest "nice" integer ≥ rawLot from {1, 2, 2.5, 5} × 10^n
//              (only integer candidates; at least 1 base unit)
//   N_eff    = floor(S_old / L) ≤ N_target              (the units cap)
//   E_eff    = N_eff × 10000 / G bps ≤ E
//
// G is any whole number of units from 100 to 10^12: 1,000,000 by default
// (MIGRATION_GRANULARITIES are the calculator's presets) and, for a
// joint-stock company, its number of shares, so that one unit is one share.
// Whatever G is, every figure above stays an exact bigint; only a
// percentage shown to a person is rounded, and then marked "≈"
// (percentFigure, percentText, percentClause).
//
// Rounding the lot UP is the point: the effective equity can only fall short
// of the shareholders' decision E, never exceed it, so the sum of delivered
// units can never pass what the decision covers. A holder deposits exact
// multiples of the lot (k × L, k ≥ 1) and gets k units; there is no change
// to give back, because nothing that is not a multiple is accepted.
//
// The parity reference E_par = marketCap / valuation is display only: it
// helps the shareholders choose E, it never changes the ratio.

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TEN = BigInt(10);
const BPS = BigInt(10_000);

/** The largest SPL token amount (u64::MAX): no supply, balance or lot can exceed it. */
export const U64_MAX = BigInt("18446744073709551615");

/** The smallest granularity G: one unit is then 1 % of the company. */
export const MIN_GRANULARITY = BigInt(100);
/** The largest granularity G, 10^12 (below 2^53: any valid G is also an exact JavaScript number). */
export const MAX_GRANULARITY = BigInt("1000000000000");
/**
 * The calculator's suggested granularities: how many units make 100 % of the
 * company. Any whole G from MIN_GRANULARITY to MAX_GRANULARITY is valid; a
 * joint-stock company uses its number of shares (owner decision 2026-11-08).
 */
export const MIGRATION_GRANULARITIES: readonly bigint[] = [
  BigInt(10_000),
  BigInt(100_000),
  BigInt(1_000_000),
  BigInt(10_000_000),
];
/** Owner decision 2026-11-08: the standard granularity of a migration class. */
export const DEFAULT_GRANULARITY = BigInt(1_000_000);

/** Below this many units in the cap, a unit is too coarse for a community: raise G (a joint-stock company: split its shares). */
export const MIN_COMFORTABLE_UNITS = BigInt(1_000);
/** E_eff may fall short of E by at most this share before the calculator warns (5 %). */
export const MAX_EQUITY_SHORTFALL_PERCENT = 5;
/** The largest number of decimals the platform handles for an old token (lib/chain-evidence tokenDecimal). */
export const MAX_OLD_DECIMALS = 18;

export class RatioInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RatioInputError";
  }
}

export type MigrationRatioInput = {
  /** The old mint's total supply, base units. */
  oldTotalSupply: bigint;
  /** Excluded wallets' balances plus any manual extra (locked, burned), base units. */
  excludedAmount: bigint;
  /** E: the share of the company for the holders, in basis points (1..10000). */
  equityBps: number;
  /** G: units that make 100 %, a whole number from 100 to 10^12 (default 1,000,000; a joint-stock company: its number of shares). */
  granularity?: bigint;
  /** The old token's decimals (0..18): only the warnings and the display read it. */
  decimals: number;
  /** Market capitalisation of the qualified supply, any currency (parity reference only). */
  marketCap?: number | null;
  /** Company valuation in the same currency (parity reference only). */
  valuation?: number | null;
};

export type RatioWarningCode = "no_units" | "few_units" | "lot_not_whole_tokens" | "equity_shortfall";
export type RatioWarning = { code: RatioWarningCode; text: string };

export type MigrationRatio = {
  oldTotalSupply: bigint;
  excludedAmount: bigint;
  /** S_old = oldTotalSupply − excludedAmount. */
  qualifiedSupply: bigint;
  equityBps: number;
  granularity: bigint;
  decimals: number;
  /** N_target = floor(E × G / 10000). */
  targetUnits: bigint;
  /** rawLot = S_old / N_target, as an exact fraction. */
  rawLot: { numerator: bigint; denominator: bigint };
  /** L: base units of the old token per unit. */
  lot: bigint;
  /** N_eff = floor(S_old / L): the most units the migration can deliver (0 only with the "no_units" warning). */
  unitsCap: bigint;
  /** E_eff in percent × 10^4, rounded down (120000 is 12.0000 %): for comparisons; show `effectiveShare`. */
  effectivePercentE4: bigint;
  /** E_eff for a person to read: rounded half up, `exact` false when that dropped digits (often, with a G that is not a power of ten). */
  effectiveShare: PercentFigure;
  /** E in percent × 10^4 (E bps × 100). */
  equityPercentE4: bigint;
  /** E_par = marketCap / valuation in percent, or null when either is missing. Display only. */
  parityPercent: number | null;
  warnings: RatioWarning[];
};

/** True for a granularity a migration class may use: a whole number of units from 100 to 10^12. */
export function isValidGranularity(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= MIN_GRANULARITY && value <= MAX_GRANULARITY;
}

/** 10^n as a bigint. */
export function pow10(n: number): bigint {
  if (!Number.isSafeInteger(n) || n < 0) throw new RatioInputError("Invalid power of ten");
  let out = ONE;
  for (let i = 0; i < n; i += 1) out *= TEN;
  return out;
}

/** ceil(a / b) for a ≥ 0, b > 0. */
function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - ONE) / b;
}

/**
 * The smallest "nice" integer ≥ `atLeast`: {1, 2, 2.5, 5} × 10^n, integer
 * candidates only (2.5 needs n ≥ 1: 25, 250, …). `atLeast` below 1 answers
 * 1, the smallest lot there is.
 */
export function niceLotAtLeast(atLeast: bigint): bigint {
  const target = atLeast < ONE ? ONE : atLeast;
  // p = the power of ten with p ≤ target < 10p.
  let p = ONE;
  while (p * TEN <= target) p *= TEN;
  const candidates = [p, BigInt(2) * p];
  if (p >= TEN) candidates.push((BigInt(25) * p) / TEN);
  candidates.push(BigInt(5) * p, TEN * p);
  for (const c of candidates) if (c >= target) return c;
  return TEN * p; // unreachable: 10p > target
}

/** True when `lot` is one of the nice numbers ({1, 2, 2.5, 5} × 10^n, integer). */
export function isNiceLot(lot: bigint): boolean {
  return lot >= ONE && niceLotAtLeast(lot) === lot;
}

function parityPercent(marketCap: number | null | undefined, valuation: number | null | undefined): number | null {
  if (typeof marketCap !== "number" || typeof valuation !== "number") return null;
  if (!Number.isFinite(marketCap) || !Number.isFinite(valuation) || marketCap <= 0 || valuation <= 0) return null;
  const percent = (marketCap / valuation) * 100;
  return Number.isFinite(percent) ? percent : null;
}

/**
 * The ratio, its cap and its warnings. THROWS RatioInputError for an input
 * the migration cannot use: a supply outside 1..u64::MAX, an excluded amount
 * that leaves nothing qualified, E outside 1..10000 bps, a granularity that
 * is not a whole number from 100 to 10^12, an E that is less than one unit
 * of that granularity, decimals outside 0..18.
 */
export function computeMigrationRatio(input: MigrationRatioInput): MigrationRatio {
  const { oldTotalSupply, excludedAmount, equityBps, decimals } = input;
  const granularity = input.granularity ?? DEFAULT_GRANULARITY;
  if (typeof oldTotalSupply !== "bigint" || oldTotalSupply < ONE || oldTotalSupply > U64_MAX) {
    throw new RatioInputError("The old token's total supply must be between 1 and 18,446,744,073,709,551,615 base units.");
  }
  if (typeof excludedAmount !== "bigint" || excludedAmount < ZERO) {
    throw new RatioInputError("The excluded amount cannot be negative.");
  }
  if (excludedAmount >= oldTotalSupply) {
    throw new RatioInputError("The excluded amount leaves no qualified supply: it must be below the total supply.");
  }
  if (!Number.isSafeInteger(equityBps) || equityBps < 1 || equityBps > 10_000) {
    throw new RatioInputError("The equity share E must be between 1 and 10,000 basis points (0.01 % to 100 %).");
  }
  if (!isValidGranularity(granularity)) {
    throw new RatioInputError(`The granularity G must be a whole number of units from ${formatUnits(MIN_GRANULARITY)} to ${formatUnits(MAX_GRANULARITY)}.`);
  }
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > MAX_OLD_DECIMALS) {
    throw new RatioInputError(`The old token's decimals must be between 0 and ${MAX_OLD_DECIMALS}.`);
  }

  const qualifiedSupply = oldTotalSupply - excludedAmount;
  const targetUnits = (BigInt(equityBps) * granularity) / BPS;
  if (targetUnits < ONE) {
    // Only a G below 10,000 gets here: E × G under 10,000 bps is not one whole unit.
    throw new RatioInputError(
      `At G = ${formatUnits(granularity)} units, E = ${formatEquityBps(equityBps)} % is less than one unit: E must be at least ${formatEquityBps(Number(ceilDiv(BPS, granularity)))} %.`,
    );
  }
  // N_target ≥ 1. The smallest integer ≥ rawLot is ceil(S_old / N_target);
  // nice numbers are integers, so the smallest nice number ≥ that integer is
  // the smallest nice number ≥ rawLot.
  const lot = niceLotAtLeast(ceilDiv(qualifiedSupply, targetUnits));
  const unitsCap = qualifiedSupply / lot;
  const effectivePercentE4 = (unitsCap * BigInt(100) * BPS) / granularity;
  const effectiveShare = percentFigure(unitsCap, granularity);
  const equityPercentE4 = BigInt(equityBps) * BigInt(100);

  const warnings: RatioWarning[] = [];
  if (unitsCap === ZERO) {
    // A qualified supply just above a nice number with a tiny N_target: the
    // lot rounds up past the whole supply. Nothing could be delivered, so
    // this is the only thing worth saying (the routes refuse such a draft).
    warnings.push({
      code: "no_units",
      text: "The lot rounds up above the whole qualified supply, so no unit could be delivered. Raise E or the granularity G.",
    });
  } else if (unitsCap < MIN_COMFORTABLE_UNITS) {
    warnings.push({
      code: "few_units",
      text: `Only ${formatUnits(unitsCap)} units can be delivered: one unit is too coarse for a community of holders. Raise the granularity G; when G is a joint-stock company's number of shares, that takes a share split first.`,
    });
  }
  const whole = pow10(decimals);
  if (lot >= whole && lot % whole !== ZERO) {
    warnings.push({
      code: "lot_not_whole_tokens",
      text: `The lot is ${formatBaseUnits(lot, decimals)} whole tokens, not a round number of whole tokens. Holders find a whole-number lot easier to deposit.`,
    });
  }
  // (E·G − N_eff·10000) / (E·G) > 5 %, exactly.
  const decided = BigInt(equityBps) * granularity;
  const shortfall = decided - unitsCap * BPS;
  if (unitsCap > ZERO && shortfall * BigInt(100) > decided * BigInt(MAX_EQUITY_SHORTFALL_PERCENT)) {
    warnings.push({
      code: "equity_shortfall",
      text: `Rounding the lot up leaves the holders ${percentText(effectiveShare)} % instead of the decided ${formatPercentE4(equityPercentE4)} %, more than ${MAX_EQUITY_SHORTFALL_PERCENT} % short. Consider a finer granularity G or a different E.`,
    });
  }

  return {
    oldTotalSupply,
    excludedAmount,
    qualifiedSupply,
    equityBps,
    granularity,
    decimals,
    targetUnits,
    rawLot: { numerator: qualifiedSupply, denominator: targetUnits },
    lot,
    unitsCap,
    effectivePercentE4,
    effectiveShare,
    equityPercentE4,
    parityPercent: parityPercent(input.marketCap, input.valuation),
    warnings,
  };
}

// ── Per holder ────────────────────────────────────────────────────────────────

/** How many whole lots a balance can deposit (0 when it holds less than one lot). */
export function lotsFor(balance: bigint, lot: bigint): bigint {
  if (lot < ONE) throw new RatioInputError("The lot must be at least 1 base unit.");
  return balance < ZERO ? ZERO : balance / lot;
}

/** The base units of a deposit of `lots` lots. */
export function depositAmountFor(lots: bigint, lot: bigint): bigint {
  if (lot < ONE) throw new RatioInputError("The lot must be at least 1 base unit.");
  if (lots < ONE) throw new RatioInputError("A deposit is at least one lot.");
  return lots * lot;
}

/** The units a deposit of `amount` earns: amount / lot for an exact multiple of at least one lot, else null. */
export function unitsForDeposit(amount: bigint, lot: bigint): bigint | null {
  if (lot < ONE) throw new RatioInputError("The lot must be at least 1 base unit.");
  if (amount < lot || amount % lot !== ZERO) return null;
  return amount / lot;
}

// ── Display ─────────────────────────────────────────────────────────────────

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "1,234,567" (en-US grouping, like the rest of the UI). */
export function formatUnits(units: bigint): string {
  const negative = units < ZERO;
  const digits = (negative ? -units : units).toString();
  return `${negative ? "-" : ""}${group(digits)}`;
}

/**
 * Base units as whole tokens: "1,234.5", "0.000001", "5,000" (exact; trailing
 * zeros of the fraction trimmed; `minFraction` keeps at least that many).
 */
export function formatBaseUnits(amount: bigint, decimals: number, minFraction = 0): string {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) throw new RatioInputError("Invalid decimals");
  const negative = amount < ZERO;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, "0");
  const whole = decimals ? digits.slice(0, -decimals) : digits;
  let fraction = decimals ? digits.slice(-decimals) : "";
  fraction = fraction.replace(/0+$/, "");
  if (fraction.length < minFraction) fraction = fraction.padEnd(Math.min(minFraction, decimals), "0");
  return `${negative ? "-" : ""}${group(whole)}${fraction ? `.${fraction}` : ""}`;
}

/**
 * Whole tokens typed by a person ("1,234.5", "1234.50", "0.25") as base units.
 * Commas are grouping only; more fraction digits than `decimals` is an error,
 * as is anything that is not a plain non-negative decimal. Null when invalid.
 */
export function parseTokenAmount(text: string, decimals: number): bigint | null {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > MAX_OLD_DECIMALS) return null;
  const value = text.trim().replace(/,/g, "");
  const match = /^(\d+)(?:\.(\d*))?$/.exec(value);
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) return null;
  const amount = BigInt(match[1]) * pow10(decimals) + (fraction ? BigInt(fraction.padEnd(decimals, "0")) : ZERO);
  return amount > U64_MAX ? null : amount;
}

/** A percent × 10^4 as "12.0000". */
export function formatPercentE4(e4: bigint): string {
  const negative = e4 < ZERO;
  const digits = (negative ? -e4 : e4).toString().padStart(5, "0");
  return `${negative ? "-" : ""}${group(digits.slice(0, -4))}.${digits.slice(-4)}`;
}

/** E in basis points as a percent: 1200 → "12", 1250 → "12.5", 1 → "0.01". */
export function formatEquityBps(bps: number): string {
  const whole = Math.floor(bps / 100);
  const rest = bps % 100;
  if (rest === 0) return `${whole}`;
  return `${whole}.${String(rest).padStart(2, "0").replace(/0$/, "")}`;
}

/**
 * Percent typed by a person ("12", "12.5", "0.01") as basis points; null when
 * it is not a plain decimal with at most two fraction digits in 0.01..100.
 */
export function parseEquityPercent(text: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0") || "0");
  return bps >= 1 && bps <= 10_000 ? bps : null;
}

/**
 * A percentage for a person to read: `text` without the "%" sign, and
 * whether it is the exact value or a rounded one.
 */
export type PercentFigure = { text: string; exact: boolean };

/** The decimals a percent figure shows, and the most it grows to for a tiny share. */
const FIGURE_DECIMALS = 4;
const FIGURE_MAX_DECIMALS = 12;

/**
 * part / whole in percent, rounded half up to 4 decimals ("12.0000"). A
 * positive share below 0.01 % gets the decimals two significant digits need
 * (at most 12: one unit of G = 10^12 is "0.0000000001"), with trailing zeros
 * past the fourth trimmed. `exact` is false when the rounding dropped
 * digits, which a G that is not a power of ten often does (3,000 units of
 * G = 37,000 are 8.108108… %): show the figure with percentText or
 * percentClause, which mark it "≈", never as a bare number.
 */
export function percentFigure(part: bigint, whole: bigint): PercentFigure {
  if (whole < ONE || part < ZERO) throw new RatioInputError("Invalid share");
  const hundredfold = part * BigInt(100);
  let decimals = FIGURE_DECIMALS;
  while (part > ZERO && decimals < FIGURE_MAX_DECIMALS && hundredfold * pow10(decimals) < TEN * whole) decimals += 1;
  const scaled = hundredfold * pow10(decimals);
  const rounded = (BigInt(2) * scaled + whole) / (BigInt(2) * whole);
  const digits = rounded.toString().padStart(decimals + 1, "0");
  let fraction = digits.slice(-decimals);
  if (decimals > FIGURE_DECIMALS) fraction = fraction.replace(/0+$/, "").padEnd(FIGURE_DECIMALS, "0");
  return { text: `${group(digits.slice(0, -decimals))}.${fraction}`, exact: scaled % whole === ZERO };
}

/** "12.0000" for an exact figure, "≈ 8.1081" for a rounded one (add " %"). */
export function percentText(figure: PercentFigure): string {
  return figure.exact ? figure.text : `≈ ${figure.text}`;
}

/** "= 0.0001 %" or "≈ 0.0027 %", for sentences such as "1 unit ≈ 0.0027 % of Acme". */
export function percentClause(figure: PercentFigure): string {
  return `${figure.exact ? "=" : "≈"} ${figure.text} %`;
}

/**
 * The share of the company one unit is, trailing zeros trimmed: G = 1,000,000
 * → "0.0001" (exact), G = 50,000 → "0.002" (exact), G = 37,000 → "0.0027"
 * (rounded: 0.0027027… %).
 */
export function unitPercent(granularity: bigint): PercentFigure {
  if (granularity < ONE) throw new RatioInputError("Invalid granularity");
  const figure = percentFigure(ONE, granularity);
  return { text: figure.text.replace(/\.?0+$/, ""), exact: figure.exact };
}

/**
 * G typed by a person ("37000", "37,000"): the bigint, or null when it is
 * not a whole number of units from 100 to 10^12. Commas and spaces are
 * grouping only.
 */
export function parseGranularity(text: string): bigint | null {
  const value = text.trim().replace(/[,\s]/g, "");
  if (!/^\d{1,13}$/.test(value)) return null;
  const granularity = BigInt(value);
  return isValidGranularity(granularity) ? granularity : null;
}

/** The parity reference as "14.3" (one decimal at most; display only). */
export function formatParityPercent(percent: number | null): string | null {
  if (percent === null || !Number.isFinite(percent)) return null;
  return percent.toLocaleString("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 0 });
}
