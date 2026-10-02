// Migration 0080, the automatic EUR rate: the worker and its routes.
//   - lib/server/fx-refresh.ts asks the four public sources and the ECB
//     (fixtures in tests/fixtures/fx/, fetch faked), rate-limits itself
//     before any outside request, and records the rate or the refusal code
//     through record_fx_auto_rate / record_fx_auto_refusal;
//   - POST /api/internal/fx needs the retry worker's credential;
//   - POST /api/admin-config/fx-rates lists, per mint, the rate that counts
//     with its origin, and writes the manual override flag.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memorySupabase } from "./helpers/memory-supabase";

vi.mock("server-only", () => ({}));
const db = vi.hoisted(() => ({ ref: null as null | ReturnType<typeof import("./helpers/memory-supabase").memorySupabase> }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => db.ref!.client }));
const signer = vi.hoisted(() => ({ wallet: "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2", params: {} as Record<string, unknown> }));
vi.mock("@/lib/server/siws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/siws")>()),
  verifySigned: vi.fn(async () => ({ wallet: signer.wallet, params: signer.params, via: "signature" })),
}));
vi.mock("@/lib/server/admin-gate", () => ({ requireAdmin: vi.fn(async () => {}), requireSuperAdmin: vi.fn(async () => {}) }));
const chain = vi.hoisted(() => ({ decimalsReads: 0 }));
vi.mock("@/lib/server/payment-mint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/payment-mint")>()),
  paymentMintInfo: vi.fn(async () => {
    chain.decimalsReads++;
    return { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", decimals: 6 };
  }),
}));

import { ECB_DAILY_XML_URL, FX_SOURCES } from "@/lib/fx-auto";
import { USDC } from "@/lib/payment-mints";
import { clearFxCaches, runFxRefresh } from "@/lib/server/fx-refresh";
import { POST as internalFx } from "@/app/api/internal/fx/route";
import { POST as fxRatesRoute } from "@/app/api/admin-config/fx-rates/route";

const fixture = (name: string) => readFileSync(join(process.cwd(), "tests/fixtures/fx", name), "utf8");
const FILES: Record<string, string> = {
  [FX_SOURCES[0].url]: "kraken-usdceur.json",
  [FX_SOURCES[1].url]: "coinbase-usdc-eur.json",
  [FX_SOURCES[2].url]: "bitstamp-usdceur.json",
  [FX_SOURCES[3].url]: "bitvavo-usdc-eur.json",
  [ECB_DAILY_XML_URL]: "ecb-eurofxref-daily.xml",
};
const NOW = Date.parse("2026-10-02T20:40:00Z");
const DEVNET_USDC = USDC.devnet!.mint;
const SECRET = "s".repeat(40);

type Handler = (url: string, init?: RequestInit) => Promise<Response> | Response | "hang";
let overrides: Record<string, Handler> = {};
const fetched: string[] = [];
async function fakeFetch(url: string, init?: RequestInit): Promise<Response> {
  fetched.push(url);
  const handler = overrides[url];
  if (handler) {
    const result = handler(url, init);
    if (result === "hang") {
      return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }
    return result;
  }
  const file = FILES[url];
  if (!file) throw new Error(`unexpected fetch ${url}`);
  return new Response(fixture(file), { status: 200 });
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

type Args = Record<string, unknown>;
let written: Args[];
let refused: Args[];
function installRpcs() {
  db.ref!.rpcs.record_fx_auto_rate = (args) => {
    written.push(args);
    return { written: true, throttled: false, as_of: new Date(NOW).toISOString() };
  };
  db.ref!.rpcs.record_fx_auto_refusal = (args) => {
    refused.push(args);
    return { written: true, throttled: false };
  };
}
const run = (opts: Parameters<typeof runFxRefresh>[0] = {}) =>
  runFxRefresh({ fetchImpl: fakeFetch, now: () => NOW, readDecimals: async () => 6, ...opts });

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  db.ref = memorySupabase();
  written = [];
  refused = [];
  overrides = {};
  fetched.length = 0;
  chain.decimalsReads = 0;
  clearFxCaches();
  installRpcs();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runFxRefresh", () => {
  it("records the median of the four sources with the ECB anchor, 15 minutes valid", async () => {
    const result = await run();
    expect(result).toMatchObject({ status: "accepted", network: "devnet", paymentMint: DEVNET_USDC, rate: "0.88895",
      ecbDate: "2026-10-02", spreadBps: 1, ecbDeviationBps: 22 });
    expect(refused).toEqual([]);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      p_network: "devnet", p_payment_mint: DEVNET_USDC, p_eur_per_token: "0.88895", p_decimals: 6, p_max_age_seconds: 900,
      p_source: "auto: median of kraken, coinbase, bitstamp, bitvavo (ECB 2026-10-02: 1.1225 USD/EUR)",
      p_quotes: {
        v: 1, median: "0.88895", spread_bps: 1, ecb_deviation_bps: 22,
        ecb: { date: "2026-10-02", usd_per_eur: "1.1225", eur_per_usd: "0.8908685969" },
        sources: { kraken: { rate: "0.88895" }, coinbase: { rate: "0.88895" }, bitstamp: { rate: "0.88898" }, bitvavo: { rate: "0.88885" } },
      },
    });
    expect(fetched.sort()).toEqual([...FX_SOURCES.map((s) => s.url), ECB_DAILY_XML_URL].sort());
  });

  it("mainnet works the same way, for the mainnet USDC", async () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    const result = await run();
    expect(result).toMatchObject({ status: "accepted", network: "mainnet", paymentMint: USDC.mainnet!.mint });
    expect(written[0]).toMatchObject({ p_network: "mainnet", p_payment_mint: USDC.mainnet!.mint });
  });

  it("testnet and localnet have no automatic rate: nothing is asked or written", async () => {
    for (const network of ["testnet", "localnet"]) {
      vi.stubEnv("NEXT_PUBLIC_NETWORK", network);
      expect(await run()).toEqual({ status: "skipped", network, reason: "NO_AUTO_MINT" });
    }
    expect(fetched).toEqual([]);
    expect(written).toEqual([]);
  });

  it("a timeout, an HTTP error, a body over the cap and a garbled answer are per-source codes; two usable sources suffice", async () => {
    overrides[FX_SOURCES[0].url] = () => "hang";
    overrides[FX_SOURCES[1].url] = () => json({ message: "down" }, 500);
    const result = await run({ signal: AbortSignal.timeout(200) });
    expect(result).toMatchObject({ status: "accepted", rate: "0.888915",
      sources: { kraken: { error: "TIMEOUT" }, coinbase: { error: "HTTP_ERROR" }, bitstamp: { rate: "0.88898" }, bitvavo: { rate: "0.88885" } } });
    expect(written[0].p_source).toBe("auto: median of bitstamp, bitvavo (ECB 2026-10-02: 1.1225 USD/EUR)");

    overrides = {
      [FX_SOURCES[0].url]: () => new Response("x".repeat(70 * 1024), { status: 200 }),
      [FX_SOURCES[1].url]: () => new Response("{not json", { status: 200 }),
      [FX_SOURCES[2].url]: () => json({ bid: "0.95", ask: "0.90" }),
      [FX_SOURCES[3].url]: () => { throw new Error("getaddrinfo ENOTFOUND api.bitvavo.com"); },
    };
    const none = await run({ now: () => NOW + 60_000 });
    expect(none).toMatchObject({ status: "refused", code: "TOO_FEW_SOURCES",
      sources: { kraken: { error: "TOO_LARGE" }, coinbase: { error: "PARSE_ERROR" }, bitstamp: { error: "CROSSED_BOOK" },
        bitvavo: { error: "TRANSPORT_ERROR" } } });
    expect(refused[0]).toMatchObject({ p_network: "devnet", p_payment_mint: DEVNET_USDC, p_code: "TOO_FEW_SOURCES" });
    expect(written).toHaveLength(1);
  });

  it("refuses (and records why) a depeg against the ECB and sources that disagree; nothing is written as a rate", async () => {
    const book = (bid: string, ask: string) => () => json({ bid, ask });
    overrides = {
      [FX_SOURCES[1].url]: book("0.8640", "0.8642"),
      [FX_SOURCES[2].url]: book("0.8641", "0.8643"),
      [FX_SOURCES[3].url]: () => json({ market: "USDC-EUR", bid: "0.8639", ask: "0.8641" }),
      [FX_SOURCES[0].url]: () => json({ error: [], result: { USDCEUR: { a: ["0.8642"], b: ["0.8640"] } } }),
    };
    expect(await run()).toMatchObject({ status: "refused", code: "ECB_DEVIATION" });
    expect(refused[0].p_quotes).toMatchObject({ ecb_deviation_bps: 300 });
    overrides[FX_SOURCES[0].url] = () => json({ error: [], result: { USDCEUR: { a: ["0.8892"], b: ["0.8890"] } } });
    expect(await run({ now: () => NOW + 60_000 })).toMatchObject({ status: "refused", code: "SOURCE_DIVERGENCE" });
    expect(written).toEqual([]);
  });

  it("the ECB is asked at most every 15 minutes; without any anchor the run is refused", async () => {
    await run();
    await run({ now: () => NOW + 60_000 });
    expect(fetched.filter((u) => u === ECB_DAILY_XML_URL)).toHaveLength(1);
    // A failing ECB keeps the cached anchor.
    overrides[ECB_DAILY_XML_URL] = () => new Response("", { status: 503 });
    expect(await run({ now: () => NOW + 20 * 60_000 })).toMatchObject({ status: "accepted" });
    clearFxCaches();
    expect(await run({ now: () => NOW + 21 * 60_000 })).toMatchObject({ status: "refused", code: "ECB_UNAVAILABLE" });
  });

  it("reads the mint's decimals from chain once per process; unreadable decimals refuse the run", async () => {
    await runFxRefresh({ fetchImpl: fakeFetch, now: () => NOW });
    await runFxRefresh({ fetchImpl: fakeFetch, now: () => NOW + 60_000 });
    expect(chain.decimalsReads).toBe(1);
    expect(written.map((w) => w.p_decimals)).toEqual([6, 6]);
    clearFxCaches();
    const result = await run({ now: () => NOW + 120_000, readDecimals: async () => { throw new Error("rpc https://x/?api-key=SECRET"); } });
    expect(result).toMatchObject({ status: "refused", code: "DECIMALS_UNAVAILABLE" });
  });

  it("rate limit: a run within 20 seconds of the last observation asks nothing outside", async () => {
    db.ref!.rows("fx_rate_observations").push({ network: "devnet", payment_mint: DEVNET_USDC, observed_at: new Date(NOW - 10_000).toISOString() });
    expect(await run()).toEqual({ status: "skipped", network: "devnet", reason: "THROTTLED" });
    expect(fetched).toEqual([]);
    // The database's own window (a concurrent run won the lock): skipped too.
    db.ref!.tables.fx_rate_observations = [];
    db.ref!.rpcs.record_fx_auto_rate = () => ({ written: false, throttled: true });
    expect(await run()).toEqual({ status: "skipped", network: "devnet", reason: "THROTTLED" });
  });

  it("before 0080, or with the database down, the run fails without asking anyone", async () => {
    db.ref!.failReads.add("fx_rate_observations");
    db.ref!.readErrorCodes.fx_rate_observations = "PGRST205";
    expect(await run()).toEqual({ status: "failed", network: "devnet", error: "NOT_INSTALLED" });
    db.ref!.readErrorCodes.fx_rate_observations = "08006";
    expect(await run()).toEqual({ status: "failed", network: "devnet", error: "DB_ERROR" });
    expect(fetched).toEqual([]);
    db.ref!.failReads.clear();
    delete db.ref!.rpcs.record_fx_auto_rate;
    expect(await run()).toEqual({ status: "failed", network: "devnet", error: "NOT_INSTALLED" });
  });

  it("logs codes only: no URL, host or message of a failing source", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const s of FX_SOURCES) overrides[s.url] = () => { throw new Error(`connect ECONNREFUSED ${s.url}?token=SECRET`); };
    await run();
    const logged = [...warn.mock.calls, ...error.mock.calls].flat().join(" ");
    expect(logged).toContain("TOO_FEW_SOURCES");
    expect(logged).not.toMatch(/https?:|SECRET|ECONNREFUSED|kraken\.com/);
  });
});

describe("POST /api/internal/fx", () => {
  const post = (authorization?: string) =>
    internalFx(new Request("https://manci.test/api/internal/fx", { method: "POST", headers: authorization ? { authorization } : {} }));

  it("needs the retry worker's credential", async () => {
    vi.stubGlobal("fetch", fakeFetch);
    vi.stubEnv("RETRY_WORKER_SECRET", "");
    expect((await post(`Bearer ${SECRET}`)).status).toBe(503);
    vi.stubEnv("RETRY_WORKER_SECRET", SECRET);
    expect((await post()).status).toBe(401);
    expect((await post("Bearer wrong")).status).toBe(401);
    expect((await post(`Basic ${SECRET}`)).status).toBe(401);
    expect(fetched).toEqual([]);
  });

  it("answers 200 with the decision, 503 when it could not be recorded; never cached", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    vi.stubGlobal("fetch", fakeFetch);
    vi.stubEnv("RETRY_WORKER_SECRET", SECRET);
    let res = await post(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, data: { status: "accepted", network: "devnet", rate: "0.88895" } });
    expect(JSON.stringify(body)).not.toContain(SECRET);
    db.ref!.rpcs.record_fx_auto_rate = () => { throw new Error("boom"); };
    res = await post(`Bearer ${SECRET}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, data: { status: "failed", error: "DB_ERROR" } });
    vi.useRealTimers();
  });
});

describe("POST /api/admin-config/fx-rates (0080)", () => {
  const call = async (params: Record<string, unknown>, action = "adminConfig.fxRatesRead") => {
    signer.params = params;
    const res = await fxRatesRoute(new Request("http://localhost/api/admin-config/fx-rates", {
      method: "POST", body: JSON.stringify({ payload: { action } }),
    }));
    return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string; data?: Record<string, unknown>[] } };
  };
  const PLAIN = "5MZBGE68wKvzAiRnh9BLcxWzWZ9EGDgvS39mgLDLKTsy";
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  it("lists one row per mint: the rate that counts, its origin, and the manual and automatic rows behind it", async () => {
    db.ref!.rows("fx_rates").push(
      { network: "devnet", payment_mint: DEVNET_USDC, kind: "rate", eur_per_token: "0.9", decimals: 6, source: "ECB", as_of: iso(86_400_000),
        max_age: "7 days", updated_by: signer.wallet, override_auto: false },
      { network: "devnet", payment_mint: PLAIN, kind: "eur_peg", eur_per_token: "1", decimals: 6, source: "peg", as_of: iso(1000),
        max_age: "7 days", updated_by: signer.wallet, override_auto: false },
    );
    db.ref!.rows("fx_auto_rates").push({ network: "devnet", payment_mint: DEVNET_USDC, eur_per_token: "0.88895", decimals: 6,
      source: "auto: median of kraken, coinbase", quotes: { sources: { kraken: { rate: "0.88895" } } }, as_of: iso(60_000), max_age: "00:15:00" });
    db.ref!.rows("fx_rate_observations").push({ network: "devnet", payment_mint: DEVNET_USDC, observed_at: iso(60_000), status: "accepted", code: null });
    const { status, body } = await call({});
    expect(status).toBe(200);
    const usdc = body.data!.find((r) => r.payment_mint === DEVNET_USDC)!;
    expect(usdc).toMatchObject({ origin: "auto", fresh: true, kind: "rate", eur_per_token: "0.88895", updated_by: "fx-auto",
      manual: { eur_per_token: "0.9" }, auto: { eur_per_token: "0.88895" }, auto_last: { status: "accepted", code: null } });
    expect(body.data!.find((r) => r.payment_mint === PLAIN)).toMatchObject({ origin: "manual", kind: "eur_peg", auto: null, auto_last: null });
  });

  it("before 0080 (no automatic table) it lists the manual rows as before", async () => {
    db.ref!.rows("fx_rates").push({ network: "devnet", payment_mint: DEVNET_USDC, kind: "rate", eur_per_token: "0.9", decimals: 6,
      source: "ECB", as_of: iso(1000), max_age: "7 days" });
    db.ref!.failReads.add("fx_auto_rates");
    db.ref!.readErrorCodes.fx_auto_rates = "42P01";
    const { status, body } = await call({});
    expect(status).toBe(200);
    expect(body.data).toEqual([expect.objectContaining({ payment_mint: DEVNET_USDC, origin: "manual", eur_per_token: "0.9", auto: null })]);
    db.ref!.readErrorCodes.fx_auto_rates = "08006";
    expect((await call({})).status).toBe(500);
  });

  it("the Super Admin writes a manual override; a peg never overrides; a non-boolean flag is refused", async () => {
    const rate = { op: "upsert", payment_mint: DEVNET_USDC, kind: "rate", eur_per_token: "0.95", source: "Bank quote", max_age_days: 2 };
    let r = await call({ ...rate, override_auto: true }, "adminConfig.fxRatesWrite");
    expect(r.status).toBe(200);
    expect(db.ref!.rows("fx_rates")[0]).toMatchObject({ payment_mint: DEVNET_USDC, eur_per_token: "0.95", override_auto: true, decimals: 6 });
    expect(r.body.data![0]).toMatchObject({ origin: "manual_override", eur_per_token: "0.95" });
    db.ref!.tables.fx_rates = [];
    r = await call({ ...rate, payment_mint: PLAIN, kind: "eur_peg", override_auto: true }, "adminConfig.fxRatesWrite");
    expect(r.status).toBe(200);
    expect(db.ref!.rows("fx_rates")[0]).toMatchObject({ kind: "eur_peg", override_auto: false });
    db.ref!.tables.fx_rates = [];
    // Without the flag the row is written as before 0080 (no override_auto column sent).
    r = await call(rate, "adminConfig.fxRatesWrite");
    expect(r.status).toBe(200);
    expect(db.ref!.rows("fx_rates")[0]).not.toHaveProperty("override_auto");
    r = await call({ ...rate, override_auto: "yes" }, "adminConfig.fxRatesWrite");
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/override_auto/);
  });
});
