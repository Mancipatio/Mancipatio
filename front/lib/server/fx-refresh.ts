// SERVER-ONLY — one run of the automatic EUR rate (migration 0080).
//
// Scheduling: its own pg_cron job, 'mancipatio-fx-<network>', every minute
// (scripts/ops/fx-scheduler.sql), calling POST /api/internal/fx with the
// retry worker's credential, like the retry, alarm and sanctions workers.
// Not a stage of those: four public HTTP sources must never cost the retry
// or alarm budgets (and their fate isolation, D7). The alarm worker only
// WATCHES the result (fxAutoReports in lib/server/alarm-checks.ts), so a job
// that stops running still pages someone.
//
// One run, for the network's USDC (lib/fx-auto.ts autoFxMint; nothing on
// testnet and localnet):
//   1. rate limit, before any outside request: claim_fx_auto_run takes the
//      run's slot atomically (per-mint lock; no observation and no other
//      claim within FX_MIN_INTERVAL_SECONDS), so concurrent calls stop here
//      without asking anyone, and a run whose recording fails still holds
//      its slot (record_fx_auto_* enforce the same window again);
//   2. in parallel, every market source (FX_SOURCES), the ECB reference
//      (cached for ECB_CACHE_MS: it changes once a working day; with nothing
//      cached and the ECB not answering, the anchor the last accepted run
//      stored, while still usable) and the mint's decimals from chain
//      (cached for the process: they never change); each request has its own
//      timeout and a body cap, and the whole step ends with the run's budget
//      (FX_RUN_BUDGET_MS: a source still out is TIMEOUT, decimals still out
//      are DECIMALS_UNAVAILABLE);
//   3. lib/fx-auto.ts aggregateFx decides; record_fx_auto_rate writes the rate
//      (fx_auto_rates + an "accepted" observation), record_fx_auto_refusal
//      writes the refusal code (the previous automatic rate stays until it
//      expires, then the manual rate applies). The recording has its own
//      bound (FX_RECORD_TIMEOUT_MS) and is not cut by the run's budget, so a
//      decision the database recorded is never answered as failed (503).
//      Values a CHECK of 0080 refuses (23514: the 0.2–5 EUR bounds of the
//      rate column, say) are not a database failure: the run is recorded as
//      refused with INVALID_FX_RATE instead (within the same recording
//      bound), or, if even that is refused, answered failed INVALID_FX_RATE
//      (503; the code lands in fx_http_runs).
// Only public prices, fixed codes and counts are stored or logged; the run
// carries no secret (the sources need no key) and logs no URL or message.
import "server-only";

import type { Address } from "@solana/kit";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ECB_DAILY_XML_URL,
  FX_AUTO_MAX_AGE_SECONDS,
  FX_SOURCES,
  FxParseError,
  aggregateFx,
  autoFxMint,
  autoSourceText,
  parseEcbDailyXml,
  rateText,
  storedEcbReference,
  type EcbReference,
  type FxQuote,
  type FxRefusalCode,
  type FxSourceError,
  type FxSourceId,
} from "@/lib/fx-auto";
import { detectNetwork, type Network } from "@/lib/network";
import { paymentMintInfo } from "@/lib/server/payment-mint";
import { tableMissing } from "@/lib/server/fx-rates";
import { getSupabaseAdmin } from "@/lib/supabase-server";

export const FX_FETCH_TIMEOUT_MS = 5_000;
export const FX_MAX_BODY_BYTES = 64 * 1024;
export const ECB_CACHE_MS = 15 * 60_000;
/** Claim, sources, anchor and decimals (the route's maxDuration is 30 s; the scheduler waits 25 s). */
export const FX_RUN_BUDGET_MS = 15_000;
/** The recording after it, outside that budget: at most FX_RUN_BUDGET_MS + this in all. */
export const FX_RECORD_TIMEOUT_MS = 5_000;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type FxSourceOutcome = { rate: string } | { error: FxSourceError };

/** A run's refusal: the aggregation's codes, or INVALID_FX_RATE when the database refused the values it was to record. */
export type FxRunRefusalCode = FxRefusalCode | "INVALID_FX_RATE";

export type FxRefreshResult =
  | {
      status: "accepted"; network: Network; paymentMint: string; rate: string; asOf: string | null;
      sources: Record<FxSourceId, FxSourceOutcome>; ecbDate: string; spreadBps: number; ecbDeviationBps: number;
      ecbToleranceBps: number;
    }
  | { status: "refused"; network: Network; paymentMint: string; code: FxRunRefusalCode; sources: Record<FxSourceId, FxSourceOutcome> }
  | { status: "skipped"; network: Network; reason: "NO_AUTO_MINT" | "THROTTLED" }
  | { status: "failed"; network: Network; error: "NOT_INSTALLED" | "DB_ERROR" | "INVALID_FX_RATE" | "UNEXPECTED" };

class SourceFailure extends Error {
  constructor(readonly code: FxSourceError) {
    super(code);
  }
}

/** The body as text, abandoned as soon as it passes `maxBytes`. */
async function readText(res: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const length = Number(res.headers.get("content-length") ?? "0");
  if (length > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new SourceFailure("TOO_LARGE");
  }
  if (!res.body) {
    const text = await res.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new SourceFailure("TOO_LARGE");
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new SourceFailure("TOO_LARGE");
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    if (err instanceof SourceFailure) throw err;
    throw new SourceFailure(signal.aborted ? "TIMEOUT" : "TRANSPORT_ERROR");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(bytes);
}

async function fetchText(fetchImpl: Fetch, url: string, accept: string, parent: AbortSignal): Promise<string> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(FX_FETCH_TIMEOUT_MS)]);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET", redirect: "error", cache: "no-store", signal,
      headers: { Accept: accept, "User-Agent": "manci-fx/1" },
    });
  } catch {
    throw new SourceFailure(signal.aborted ? "TIMEOUT" : "TRANSPORT_ERROR");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new SourceFailure("HTTP_ERROR");
  }
  return readText(res, FX_MAX_BODY_BYTES, signal);
}

async function quote(fetchImpl: Fetch, source: (typeof FX_SOURCES)[number], signal: AbortSignal): Promise<FxQuote> {
  try {
    const text = await fetchText(fetchImpl, source.url, "application/json", signal);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new FxParseError("PARSE_ERROR");
    }
    return { source: source.id, rate: source.parse(body) };
  } catch (err) {
    const code: FxSourceError = err instanceof SourceFailure || err instanceof FxParseError ? err.code : "TRANSPORT_ERROR";
    return { source: source.id, error: code };
  }
}

let ecbCache: { at: number; ref: EcbReference } | null = null;
const decimalsCache = new Map<string, number>();

/** Tests: forget the ECB reference and the mint decimals. */
export function clearFxCaches() {
  ecbCache = null;
  decimalsCache.clear();
}

type Anchor = { ref: EcbReference; stored: boolean };

/**
 * The ECB anchor: the cached one while younger than ECB_CACHE_MS, else a
 * fresh fetch; if the ECB does not answer, the cached one whatever its age
 * (aggregateFx judges its date), and with nothing cached (a new instance)
 * the anchor the last accepted run stored with its rate, if it parses and
 * passes the ECB_STALE limit (`stored`: never cached, so the next run asks
 * the ECB again).
 */
async function ecbAnchor(
  fetchImpl: Fetch, signal: AbortSignal, now: number, storedQuotes: () => Promise<unknown>,
): Promise<Anchor | null> {
  if (ecbCache && now - ecbCache.at < ECB_CACHE_MS) return { ref: ecbCache.ref, stored: false };
  try {
    const ref = parseEcbDailyXml(await fetchText(fetchImpl, ECB_DAILY_XML_URL, "application/xml, text/xml", signal));
    ecbCache = { at: now, ref };
    return { ref, stored: false };
  } catch {
    if (ecbCache) return { ref: ecbCache.ref, stored: false };
    const ref = storedEcbReference(await storedQuotes().catch(() => null), now);
    return ref ? { ref, stored: true } : null;
  }
}

/** `promise`, or null as soon as `signal` aborts (the run's budget); a rejection is null too. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(null);
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      () => { signal.removeEventListener("abort", onAbort); resolve(null); },
    );
  });
}

/** The mint's decimals; null when unreadable or still out when the run's budget ends (a late answer is cached for the next run). */
async function mintDecimals(
  mint: string, network: Network, read: (mint: string, network: Network) => Promise<number>, signal: AbortSignal,
): Promise<number | null> {
  const cached = decimalsCache.get(mint);
  if (cached !== undefined) return cached;
  const reading = Promise.resolve().then(() => read(mint, network)).then((decimals) => {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
    decimalsCache.set(mint, decimals);
    return decimals;
  });
  return untilAborted(reading, signal);
}

/** Before 0080: the function (PGRST202) or a table behind it (42P01, PGRST205) does not exist. */
function notInstalled(error: { code?: string } | null): boolean {
  return tableMissing(error) || error?.code === "PGRST202";
}

/**
 * The database refused the values, not the call: a CHECK constraint (23514,
 * e.g. fx_auto_rates_eur_per_token_bounds) or the writer's own input check
 * (P0001 INVALID_FX_RATE).
 */
function invalidValues(error: { code?: string; message?: string } | null): boolean {
  return error?.code === "23514" || (error?.code === "P0001" && error.message === "INVALID_FX_RATE");
}

const chainDecimals = async (mint: string, network: Network) => (await paymentMintInfo(mint as Address, network)).decimals;

export async function runFxRefresh(opts: {
  sb?: SupabaseClient;
  fetchImpl?: Fetch;
  now?: () => number;
  signal?: AbortSignal;
  /** The mint's decimals (default: read from chain, lib/server/payment-mint). */
  readDecimals?: (mint: string, network: Network) => Promise<number>;
} = {}): Promise<FxRefreshResult> {
  const network = detectNetwork();
  const mint = autoFxMint(network);
  if (!mint) return { status: "skipped", network, reason: "NO_AUTO_MINT" };
  const now = opts.now ?? Date.now;
  const sb = opts.sb ?? getSupabaseAdmin();
  const signal = opts.signal ?? AbortSignal.timeout(FX_RUN_BUDGET_MS);
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    // 1. Rate limit before any outside request: claim the run's slot atomically.
    const claim = await sb.rpc("claim_fx_auto_run", { p_network: network, p_payment_mint: mint })
      .abortSignal(AbortSignal.any([signal, AbortSignal.timeout(5_000)]));
    if (claim.error) {
      return { status: "failed", network, error: notInstalled(claim.error) ? "NOT_INSTALLED" : "DB_ERROR" };
    }
    if ((claim.data as { claimed?: unknown } | null)?.claimed !== true) {
      return { status: "skipped", network, reason: "THROTTLED" };
    }

    // 2. The sources, the anchor and the decimals, in parallel, within the run's budget.
    const storedQuotes = async () => {
      const { data, error } = await sb.from("fx_auto_rates").select("quotes").eq("network", network).eq("payment_mint", mint)
        .abortSignal(AbortSignal.any([signal, AbortSignal.timeout(5_000)])).maybeSingle();
      return error ? null : (data as { quotes?: unknown } | null)?.quotes ?? null;
    };
    const [quotes, anchor, decimals] = await Promise.all([
      Promise.all(FX_SOURCES.map((source) => quote(fetchImpl, source, signal))),
      ecbAnchor(fetchImpl, signal, now(), storedQuotes),
      mintDecimals(mint, network, opts.readDecimals ?? chainDecimals, signal),
    ]);
    const ecb = anchor?.ref ?? null;
    const sources = Object.fromEntries(quotes.map((q) => [q.source, "rate" in q ? { rate: rateText(q.rate) } : { error: q.error }])) as
      Record<FxSourceId, FxSourceOutcome>;
    const result = aggregateFx(quotes, ecb, now());
    const evidence = {
      v: 1,
      sources,
      median: result.median === null ? null : rateText(result.median),
      spread_bps: result.spreadBps,
      ecb: ecb ? {
        date: ecb.date, usd_per_eur: String(ecb.usdPerEur), eur_per_usd: rateText(1 / ecb.usdPerEur),
        ...(anchor?.stored ? { stored: true } : {}),
      } : null,
      ecb_deviation_bps: result.ecbDeviationBps,
      ecb_tolerance_bps: result.ecbToleranceBps,
    };
    const code: FxRefusalCode | null = !result.ok ? result.code : decimals === null ? "DECIMALS_UNAVAILABLE" : null;
    // Not the run's budget: a write the database committed must not be
    // reported as failed because the budget ran out while its answer was on
    // the way.
    const dbSignal = AbortSignal.timeout(FX_RECORD_TIMEOUT_MS);

    /** Records a refusal: refused; skipped when throttled; failed when the database cannot take it. */
    const refuse = async (refusal: FxRunRefusalCode, quotes: Record<string, unknown>): Promise<FxRefreshResult> => {
      const { data, error } = await sb.rpc("record_fx_auto_refusal", {
        p_network: network, p_payment_mint: mint, p_code: refusal, p_quotes: quotes,
      }).abortSignal(dbSignal);
      if (error && invalidValues(error)) {
        // The refusal itself was refused: record that once, else say so.
        if (refusal !== "INVALID_FX_RATE") return refuse("INVALID_FX_RATE", { ...quotes, refused_code: refusal });
        console.error("[fx] the database refused the run's values (INVALID_FX_RATE) and the refusal could not be recorded");
        return { status: "failed", network, error: "INVALID_FX_RATE" };
      }
      if (error) return { status: "failed", network, error: notInstalled(error) ? "NOT_INSTALLED" : "DB_ERROR" };
      // Not recorded (a concurrent run recorded within the window): nothing was decided here.
      if ((data as { written?: unknown } | null)?.written === false) return { status: "skipped", network, reason: "THROTTLED" };
      console.warn(`[fx] automatic rate refused: ${refusal}`);
      return { status: "refused", network, paymentMint: mint, code: refusal, sources };
    };

    // 3. Record the rate or the refusal.
    if (code !== null || !result.rate || !ecb || decimals === null) return await refuse(code ?? "TOO_FEW_SOURCES", evidence);
    const { data, error } = await sb.rpc("record_fx_auto_rate", {
      p_network: network, p_payment_mint: mint, p_eur_per_token: result.rate, p_decimals: decimals,
      p_source: autoSourceText(result.used, ecb), p_quotes: evidence, p_max_age_seconds: FX_AUTO_MAX_AGE_SECONDS,
    }).abortSignal(dbSignal);
    // A rate the database's CHECKs refuse (outside 0.2–5 EUR, say) is a refusal, recorded with the rate it refused.
    if (error && invalidValues(error)) return await refuse("INVALID_FX_RATE", { ...evidence, refused_rate: result.rate });
    if (error) return { status: "failed", network, error: notInstalled(error) ? "NOT_INSTALLED" : "DB_ERROR" };
    const written = (data ?? {}) as { written?: boolean; as_of?: string };
    if (written.written === false) return { status: "skipped", network, reason: "THROTTLED" };
    return {
      status: "accepted", network, paymentMint: mint, rate: result.rate, asOf: written.as_of ?? null, sources,
      ecbDate: ecb.date, spreadBps: result.spreadBps ?? 0, ecbDeviationBps: result.ecbDeviationBps ?? 0,
      ecbToleranceBps: result.ecbToleranceBps ?? 0,
    };
  } catch {
    console.error("[fx] automatic rate run failed");
    return { status: "failed", network, error: "UNEXPECTED" };
  }
}
