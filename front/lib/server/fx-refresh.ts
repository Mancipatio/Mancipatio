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
//   1. rate limit: when the newest observation is younger than
//      FX_MIN_INTERVAL_SECONDS the run stops before any outside request
//      (record_fx_auto_* enforce the same window under a lock);
//   2. in parallel, every market source (FX_SOURCES), the ECB reference
//      (cached for ECB_CACHE_MS: it changes once a working day) and the
//      mint's decimals from chain (cached for the process: they never change);
//      each request has its own timeout and a body cap;
//   3. lib/fx-auto.ts aggregateFx decides; record_fx_auto_rate writes the rate
//      (fx_auto_rates + an "accepted" observation), record_fx_auto_refusal
//      writes the refusal code (the previous automatic rate stays until it
//      expires, then the manual rate applies).
// Only public prices, fixed codes and counts are stored or logged; the run
// carries no secret (the sources need no key) and logs no URL or message.
import "server-only";

import type { Address } from "@solana/kit";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ECB_DAILY_XML_URL,
  FX_AUTO_MAX_AGE_SECONDS,
  FX_MIN_INTERVAL_SECONDS,
  FX_SOURCES,
  FxParseError,
  aggregateFx,
  autoFxMint,
  autoSourceText,
  parseEcbDailyXml,
  rateText,
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
/** The whole run (the route's maxDuration is 30 s; the scheduler waits 25 s). */
export const FX_RUN_BUDGET_MS = 15_000;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type FxSourceOutcome = { rate: string } | { error: FxSourceError };

export type FxRefreshResult =
  | {
      status: "accepted"; network: Network; paymentMint: string; rate: string; asOf: string | null;
      sources: Record<FxSourceId, FxSourceOutcome>; ecbDate: string; spreadBps: number; ecbDeviationBps: number;
    }
  | { status: "refused"; network: Network; paymentMint: string; code: FxRefusalCode; sources: Record<FxSourceId, FxSourceOutcome> }
  | { status: "skipped"; network: Network; reason: "NO_AUTO_MINT" | "THROTTLED" }
  | { status: "failed"; network: Network; error: "NOT_INSTALLED" | "DB_ERROR" | "UNEXPECTED" };

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

async function ecbReference(fetchImpl: Fetch, signal: AbortSignal, now: number): Promise<EcbReference | null> {
  if (ecbCache && now - ecbCache.at < ECB_CACHE_MS) return ecbCache.ref;
  try {
    const ref = parseEcbDailyXml(await fetchText(fetchImpl, ECB_DAILY_XML_URL, "application/xml, text/xml", signal));
    ecbCache = { at: now, ref };
    return ref;
  } catch {
    // An older cached reference is still an anchor; aggregateFx judges its date.
    return ecbCache?.ref ?? null;
  }
}

async function mintDecimals(
  mint: string, network: Network, read: (mint: string, network: Network) => Promise<number>,
): Promise<number | null> {
  const cached = decimalsCache.get(mint);
  if (cached !== undefined) return cached;
  try {
    const decimals = await read(mint, network);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
    decimalsCache.set(mint, decimals);
    return decimals;
  } catch {
    return null;
  }
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
    // 1. Rate limit before any outside request.
    const last = await sb.from("fx_rate_observations").select("observed_at")
      .eq("network", network).eq("payment_mint", mint)
      .order("observed_at", { ascending: false }).limit(1)
      .abortSignal(AbortSignal.any([signal, AbortSignal.timeout(5_000)])).maybeSingle();
    if (last.error) {
      return { status: "failed", network, error: tableMissing(last.error) ? "NOT_INSTALLED" : "DB_ERROR" };
    }
    const lastAt = Date.parse((last.data as { observed_at?: string } | null)?.observed_at ?? "");
    if (Number.isFinite(lastAt) && now() - lastAt < FX_MIN_INTERVAL_SECONDS * 1000) {
      return { status: "skipped", network, reason: "THROTTLED" };
    }

    // 2. The sources, the anchor and the decimals, in parallel.
    const [quotes, ecb, decimals] = await Promise.all([
      Promise.all(FX_SOURCES.map((source) => quote(fetchImpl, source, signal))),
      ecbReference(fetchImpl, signal, now()),
      mintDecimals(mint, network, opts.readDecimals ?? chainDecimals),
    ]);
    const sources = Object.fromEntries(quotes.map((q) => [q.source, "rate" in q ? { rate: rateText(q.rate) } : { error: q.error }])) as
      Record<FxSourceId, FxSourceOutcome>;
    const result = aggregateFx(quotes, ecb, now());
    const evidence = {
      v: 1,
      sources,
      median: result.median === null ? null : rateText(result.median),
      spread_bps: result.spreadBps,
      ecb: ecb ? { date: ecb.date, usd_per_eur: String(ecb.usdPerEur), eur_per_usd: rateText(1 / ecb.usdPerEur) } : null,
      ecb_deviation_bps: result.ecbDeviationBps,
    };
    const code: FxRefusalCode | null = !result.ok ? result.code : decimals === null ? "DECIMALS_UNAVAILABLE" : null;
    const dbSignal = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);

    // 3. Record the rate or the refusal.
    if (code !== null || !result.rate || !ecb || decimals === null) {
      const { error } = await sb.rpc("record_fx_auto_refusal", {
        p_network: network, p_payment_mint: mint, p_code: code ?? "TOO_FEW_SOURCES", p_quotes: evidence,
      }).abortSignal(dbSignal);
      if (error) return { status: "failed", network, error: tableMissing(error) || error.code === "PGRST202" ? "NOT_INSTALLED" : "DB_ERROR" };
      console.warn(`[fx] automatic rate refused: ${code}`);
      return { status: "refused", network, paymentMint: mint, code: code ?? "TOO_FEW_SOURCES", sources };
    }
    const { data, error } = await sb.rpc("record_fx_auto_rate", {
      p_network: network, p_payment_mint: mint, p_eur_per_token: result.rate, p_decimals: decimals,
      p_source: autoSourceText(result.used, ecb), p_quotes: evidence, p_max_age_seconds: FX_AUTO_MAX_AGE_SECONDS,
    }).abortSignal(dbSignal);
    if (error) return { status: "failed", network, error: error.code === "PGRST202" ? "NOT_INSTALLED" : "DB_ERROR" };
    const written = (data ?? {}) as { written?: boolean; as_of?: string };
    if (written.written === false) return { status: "skipped", network, reason: "THROTTLED" };
    return {
      status: "accepted", network, paymentMint: mint, rate: result.rate, asOf: written.as_of ?? null, sources,
      ecbDate: ecb.date, spreadBps: result.spreadBps ?? 0, ecbDeviationBps: result.ecbDeviationBps ?? 0,
    };
  } catch {
    console.error("[fx] automatic rate run failed");
    return { status: "failed", network, error: "UNEXPECTED" };
  }
}
