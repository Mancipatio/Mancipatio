// The automatic EUR rate of the network's USDC (migration 0080). Pure and
// isomorphic: the public sources, their parsers, the ECB anchor and the
// aggregation rule. The fetching and the database writes are in
// lib/server/fx-refresh.ts; the choice between the automatic and the manual
// rate is lib/fx-effective.ts (the same rule as SQL public.fx_effective_rate).
//
// The rule, per run (once a minute, scripts/ops/fx-scheduler.sql):
//   1. ask every market source (public order books, no API key) for USDC/EUR
//      and keep each answer whose mid price is sane (a positive, uncrossed
//      book between 0.2 and 5 EUR per USDC);
//   2. at least FX_AUTO_MIN_SOURCES answers, else TOO_FEW_SOURCES;
//   3. the rate is their MEDIAN; if any two answers differ by more than
//      FX_MAX_SPREAD (1 %) of it, SOURCE_DIVERGENCE (a source is broken or
//      the market is disorderly: nothing is written);
//   4. the official anchor is the ECB euro reference rate for USD (one USDC is
//      taken as one USD): no usable ECB rate (ECB_UNAVAILABLE, ECB_STALE), or a
//      median further from 1 / (USD per EUR) than ecbTolerance(age of the fix)
//      (2.5 % for a fix up to a day old, one point more per further day, at
//      most 5 %) — a USDC depeg, a large EUR/USD move since the fix or a
//      broken feed — ECB_DEVIATION: nothing is written;
//   5. otherwise the median, rounded to 10 decimals (numeric(20,10)), becomes
//      the automatic rate with a max age of FX_AUTO_MAX_AGE_SECONDS (15 min).
// A refusal keeps the previous automatic rate until it expires; then the
// manual rate of /admin/limits applies (lib/fx-effective.ts) and the alarm
// worker reports why (lib/server/alarm-checks.ts fxAutoReports).
import { USDC, requiredFxKind } from "@/lib/payment-mints";
import type { Network } from "@/lib/network";

/** An automatic rate is used for this long after it was observed. */
export const FX_AUTO_MAX_AGE_SECONDS = 15 * 60;
export const FX_AUTO_MIN_SOURCES = 2;
/** Refuse when (max − min) / median of the market answers exceeds this. */
export const FX_MAX_SPREAD = 0.01;
/** The ECB publishes on TARGET working days around 16:00 CET; Easter is the longest gap. */
export const FX_ECB_MAX_AGE_DAYS = 6;
/** A market answer outside these bounds (EUR per USDC) is not a quote. */
export const FX_QUOTE_BOUNDS = { min: 0.2, max: 5 } as const;
/** A book wider than this (ask / bid − 1) is not a usable quote. */
export const FX_MAX_BOOK_SPREAD = 0.02;
/** The database refuses a second run (claim_fx_auto_run) or observation within this window (rate limit, 0080). */
export const FX_MIN_INTERVAL_SECONDS = 20;
/** Alarm (fx-jump): accepted rates moved more than this within FX_JUMP_WINDOW_MS. */
export const FX_JUMP_THRESHOLD = 0.01;
export const FX_JUMP_WINDOW_MS = 60 * 60_000;
/** Alarm (fx-source-down): a source without a usable answer for this long. */
export const FX_SOURCE_DOWN_MS = 15 * 60_000;
/** Alarm (fx-depeg, fx-divergence): this many refusals in a row. */
export const FX_REFUSAL_STREAK = 3;
/** The marker `updated_by` an automatic row carries when it is used as an fx_rates row. */
export const FX_AUTO_UPDATED_BY = "fx-auto";

export const ECB_DAILY_XML_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

export type FxSourceId = "kraken" | "coinbase" | "bitstamp" | "bitvavo";
export type FxRefusalCode =
  | "TOO_FEW_SOURCES" | "SOURCE_DIVERGENCE" | "ECB_UNAVAILABLE" | "ECB_STALE" | "ECB_DEVIATION" | "DECIMALS_UNAVAILABLE";
export type FxSourceError =
  | "TIMEOUT" | "TRANSPORT_ERROR" | "HTTP_ERROR" | "TOO_LARGE" | "PARSE_ERROR" | "OUT_OF_RANGE" | "CROSSED_BOOK";

export class FxParseError extends Error {
  constructor(readonly code: "PARSE_ERROR" | "OUT_OF_RANGE" | "CROSSED_BOOK") {
    super(code);
  }
}

const DECIMAL = /^\d{1,6}(?:\.\d{1,12})?$/;

function decimal(value: unknown): number {
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new FxParseError("PARSE_ERROR");
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new FxParseError("PARSE_ERROR");
  return n;
}

/** The mid price of a best bid and ask, checked for a crossed or absurdly wide book. */
export function bookMid(bidText: unknown, askText: unknown): number {
  const bid = decimal(bidText);
  const ask = decimal(askText);
  if (ask < bid || ask / bid - 1 > FX_MAX_BOOK_SPREAD) throw new FxParseError("CROSSED_BOOK");
  const mid = (bid + ask) / 2;
  if (mid < FX_QUOTE_BOUNDS.min || mid > FX_QUOTE_BOUNDS.max) throw new FxParseError("OUT_OF_RANGE");
  return mid;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FxParseError("PARSE_ERROR");
  return value as Record<string, unknown>;
}

export type FxSource = {
  id: FxSourceId;
  /** Display name. */
  label: string;
  /** Public endpoint, no key. */
  url: string;
  /** EUR per USDC from the parsed JSON body; throws FxParseError. */
  parse: (body: unknown) => number;
};

/**
 * The market sources (verified 2026-10-02; each answers USDC/EUR without a
 * key). Order is display order only; the rate is their median.
 */
export const FX_SOURCES: readonly FxSource[] = Object.freeze([
  {
    id: "kraken", label: "Kraken", url: "https://api.kraken.com/0/public/Ticker?pair=USDCEUR",
    parse: (body) => {
      const root = object(body);
      if (!Array.isArray(root.error) || root.error.length > 0) throw new FxParseError("PARSE_ERROR");
      const result = object(root.result);
      const pair = object(result.USDCEUR);
      const ask = Array.isArray(pair.a) ? pair.a[0] : undefined;
      const bid = Array.isArray(pair.b) ? pair.b[0] : undefined;
      return bookMid(bid, ask);
    },
  },
  {
    id: "coinbase", label: "Coinbase", url: "https://api.exchange.coinbase.com/products/USDC-EUR/ticker",
    parse: (body) => {
      const root = object(body);
      return bookMid(root.bid, root.ask);
    },
  },
  {
    id: "bitstamp", label: "Bitstamp", url: "https://www.bitstamp.net/api/v2/ticker/usdceur/",
    parse: (body) => {
      const root = object(body);
      return bookMid(root.bid, root.ask);
    },
  },
  {
    id: "bitvavo", label: "Bitvavo", url: "https://api.bitvavo.com/v2/ticker/book?market=USDC-EUR",
    parse: (body) => {
      const root = object(body);
      if (root.market !== "USDC-EUR") throw new FxParseError("PARSE_ERROR");
      return bookMid(root.bid, root.ask);
    },
  },
]);

export type EcbReference = { date: string; usdPerEur: number };

/** An ECB date and USD rate as text, checked; throws FxParseError. */
function ecbReference(date: unknown, usdPerEurText: unknown): EcbReference {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))) {
    throw new FxParseError("PARSE_ERROR");
  }
  const usdPerEur = decimal(usdPerEurText);
  // EUR per USD must itself be a sane quote.
  if (1 / usdPerEur < FX_QUOTE_BOUNDS.min || 1 / usdPerEur > FX_QUOTE_BOUNDS.max) throw new FxParseError("OUT_OF_RANGE");
  return { date, usdPerEur };
}

/**
 * The USD reference rate of the ECB's daily XML (`<Cube time='YYYY-MM-DD'>`
 * with `<Cube currency='USD' rate='1.1225'/>`). Throws FxParseError.
 */
export function parseEcbDailyXml(xml: string): EcbReference {
  if (typeof xml !== "string" || xml.length > 64 * 1024) throw new FxParseError("PARSE_ERROR");
  const time = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*>/.exec(xml);
  const usd = /<Cube\s+currency=['"]USD['"]\s+rate=['"]([0-9.]{1,20})['"]\s*\/>/.exec(xml);
  if (!time || !usd) throw new FxParseError("PARSE_ERROR");
  return ecbReference(time[1], usd[1]);
}

/** Age in days of the ECB fix of `date` at `now`, counted from 00:00Z of that date. */
export function ecbAgeDays(date: string, now: number): number {
  return (now - Date.parse(`${date}T00:00:00Z`)) / 86_400_000;
}

/** Whether a fix that old is an anchor at all (else ECB_STALE). A date more than a day ahead of us is as unusable as an old one. */
function ecbUsable(ageDays: number): boolean {
  return Number.isFinite(ageDays) && ageDays <= FX_ECB_MAX_AGE_DAYS && ageDays >= -1;
}

/**
 * The band around the ECB anchor for a fix `ageDays` old: refuse when
 * |median − ECB| / ECB exceeds it. 2.5 % for a fix up to a day old, one
 * point more per further day, at most 5 %. The fix is published once a
 * TARGET working day, so on an ordinary day it is up to ~1.6 days old when
 * the next one appears, 3.6 over a weekend and 5.6 at Easter, and EUR/USD
 * keeps moving meanwhile: a fixed band would page an ordinary move as a
 * depeg.
 */
export function ecbTolerance(ageDays: number): number {
  return Math.min(0.05, 0.025 + 0.01 * Math.max(0, ageDays - 1));
}

/**
 * The ECB anchor an accepted run stored with its rate (fx_auto_rates.quotes,
 * `ecb: { date, usd_per_eur }`, lib/server/fx-refresh.ts): checked exactly
 * like a fetched one, and null unless it parses and is still within
 * FX_ECB_MAX_AGE_DAYS at `now`.
 */
export function storedEcbReference(quotes: unknown, now: number): EcbReference | null {
  try {
    const ecb = object(object(quotes).ecb);
    const ref = ecbReference(ecb.date, ecb.usd_per_eur);
    return ecbUsable(ecbAgeDays(ref.date, now)) ? ref : null;
  } catch {
    return null;
  }
}

export type FxQuote = { source: FxSourceId; rate: number } | { source: FxSourceId; error: FxSourceError };

export type FxAggregate = {
  ok: boolean;
  /** Set when ok: the rate written, 10 decimals at most. */
  rate: string | null;
  code: FxRefusalCode | null;
  median: number | null;
  /** (max − min) / median of the usable answers, in basis points. */
  spreadBps: number | null;
  /** EUR per USD from the ECB. */
  ecbRate: number | null;
  /** |median − ECB| / ECB, in basis points. */
  ecbDeviationBps: number | null;
  /** The band the deviation was judged against (ecbTolerance), in basis points. */
  ecbToleranceBps: number | null;
  used: FxSourceId[];
};

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** A positive decimal with at most 10 fraction digits, as numeric(20,10) stores it. */
export function rateText(value: number): string {
  const fixed = value.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  return fixed;
}

const bps = (fraction: number) => Math.round(fraction * 10_000);

/** Steps 2–5 of the rule above. `now` dates the ECB reference. */
export function aggregateFx(quotes: readonly FxQuote[], ecb: EcbReference | null, now: number): FxAggregate {
  const usable = quotes.filter((q): q is { source: FxSourceId; rate: number } =>
    "rate" in q && Number.isFinite(q.rate) && q.rate >= FX_QUOTE_BOUNDS.min && q.rate <= FX_QUOTE_BOUNDS.max);
  const used = usable.map((q) => q.source);
  const refuse = (code: FxRefusalCode, extra: Partial<FxAggregate> = {}): FxAggregate => ({
    ok: false, rate: null, code, median: null, spreadBps: null, ecbRate: null, ecbDeviationBps: null, ecbToleranceBps: null, used,
    ...extra,
  });
  if (usable.length < FX_AUTO_MIN_SOURCES) return refuse("TOO_FEW_SOURCES");
  const rates = usable.map((q) => q.rate);
  const mid = median(rates);
  const spread = (Math.max(...rates) - Math.min(...rates)) / mid;
  const measured = { median: mid, spreadBps: bps(spread) };
  if (spread > FX_MAX_SPREAD) return refuse("SOURCE_DIVERGENCE", measured);
  if (!ecb) return refuse("ECB_UNAVAILABLE", measured);
  const ageDays = ecbAgeDays(ecb.date, now);
  if (!ecbUsable(ageDays)) return refuse("ECB_STALE", measured);
  const ecbRate = 1 / ecb.usdPerEur;
  const deviation = Math.abs(mid - ecbRate) / ecbRate;
  const tolerance = ecbTolerance(ageDays);
  const anchored = { ...measured, ecbRate, ecbDeviationBps: bps(deviation), ecbToleranceBps: bps(tolerance) };
  if (deviation > tolerance) return refuse("ECB_DEVIATION", anchored);
  return { ok: true, rate: rateText(mid), code: null, ...anchored, used };
}

/**
 * The mint the automatic rate is kept for: the network's USDC (the only
 * "rate" payment token; an EUR stablecoin is pegged and needs no rate). On
 * mainnet only while the allowlist fixes it as kind "rate". None on testnet
 * and localnet.
 */
export function autoFxMint(network: Network): string | null {
  const mint = USDC[network]?.mint ?? null;
  if (!mint) return null;
  if (network === "mainnet" && requiredFxKind(network, mint) !== "rate") return null;
  return mint;
}

/** The fx_rates `source` text of an automatic rate (at most 200 characters). */
export function autoSourceText(used: readonly FxSourceId[], ecb: EcbReference): string {
  return `auto: median of ${used.join(", ")} (ECB ${ecb.date}: ${ecb.usdPerEur} USD/EUR)`.slice(0, 200);
}
