// Migration 0080, the automatic EUR rate: the worker and its routes.
//   - lib/server/fx-refresh.ts claims its slot (claim_fx_auto_run) before
//     any outside request, asks the four public sources and the ECB
//     (fixtures in tests/fixtures/fx/, fetch faked), and records the rate or
//     the refusal code through record_fx_auto_rate / record_fx_auto_refusal;
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
let claims: Args[];
function installRpcs() {
  db.ref!.rpcs.claim_fx_auto_run = (args) => {
    claims.push(args);
    return { claimed: true };
  };
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
  claims = [];
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
      ecbDate: "2026-10-02", spreadBps: 1, ecbDeviationBps: 22, ecbToleranceBps: 250 });
    expect(refused).toEqual([]);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      p_network: "devnet", p_payment_mint: DEVNET_USDC, p_eur_per_token: "0.88895", p_decimals: 6, p_max_age_seconds: 900,
      p_source: "auto: median of kraken, coinbase, bitstamp, bitvavo (ECB 2026-10-02: 1.1225 USD/EUR)",
      p_quotes: {
        v: 1, median: "0.88895", spread_bps: 1, ecb_deviation_bps: 22, ecb_tolerance_bps: 250,
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
    expect(refused[0].p_quotes).toMatchObject({ ecb_deviation_bps: 300, ecb_tolerance_bps: 250 });
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

  it("a new instance whose ECB fetch fails anchors on the ECB rate the last accepted run stored, while it is usable", async () => {
    overrides[ECB_DAILY_XML_URL] = () => new Response("", { status: 503 });
    const stored = (ecb: Record<string, unknown>) => {
      db.ref!.tables.fx_auto_rates = [{ network: "devnet", payment_mint: DEVNET_USDC, eur_per_token: "0.889", decimals: 6, source: "auto",
        quotes: { v: 1, ecb }, as_of: new Date(NOW - 20 * 60_000).toISOString(), max_age: "00:15:00" }];
    };
    stored({ date: "2026-10-02", usd_per_eur: "1.1225", eur_per_usd: "0.8908685969" });
    expect(await run()).toMatchObject({ status: "accepted", ecbDate: "2026-10-02", ecbDeviationBps: 22 });
    expect(written[0].p_quotes).toMatchObject({ ecb: { date: "2026-10-02", usd_per_eur: "1.1225", stored: true } });
    expect(fetched).toContain(ECB_DAILY_XML_URL);
    // Not cached: the next run asks the ECB again.
    fetched.length = 0;
    await run({ now: () => NOW + 60_000 });
    expect(fetched).toContain(ECB_DAILY_XML_URL);
    // Past the ECB_STALE limit, an unparseable anchor or an unreadable table: no anchor.
    stored({ date: "2026-09-25", usd_per_eur: "1.1225" });
    expect(await run({ now: () => NOW + 120_000 })).toMatchObject({ status: "refused", code: "ECB_UNAVAILABLE" });
    stored({ date: "2026-10-02", usd_per_eur: "a lot" });
    expect(await run({ now: () => NOW + 180_000 })).toMatchObject({ status: "refused", code: "ECB_UNAVAILABLE" });
    db.ref!.failReads.add("fx_auto_rates");
    stored({ date: "2026-10-02", usd_per_eur: "1.1225" });
    expect(await run({ now: () => NOW + 240_000 })).toMatchObject({ status: "refused", code: "ECB_UNAVAILABLE" });
  });

  it("decimals still out when the run's budget ends refuse the run, which is still recorded (never failed)", async () => {
    // A hanging chain read must neither hold the run past its budget nor cost the recording.
    const signals: Record<string, AbortSignal> = {};
    const client = db.ref!.client as { rpc: (name: string, args?: Record<string, unknown>) => { abortSignal: (s: AbortSignal) => unknown } };
    const rpc = client.rpc;
    client.rpc = (name, args) => {
      const builder = rpc(name, args);
      const abortSignal = builder.abortSignal;
      builder.abortSignal = (signal) => { signals[name] = signal; return abortSignal(signal); };
      return builder;
    };
    const budget = AbortSignal.timeout(200);
    const started = Date.now();
    const result = await run({ signal: budget, readDecimals: () => new Promise<number>(() => {}) });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result).toMatchObject({ status: "refused", code: "DECIMALS_UNAVAILABLE" });
    expect(refused).toHaveLength(1);
    expect(budget.aborted).toBe(true);
    // The recording has its own bound, not the (spent) run budget.
    expect(signals.record_fx_auto_refusal.aborted).toBe(false);
    // A late answer is kept for the next run.
    clearFxCaches();
    let answer: (d: number) => void = () => {};
    const late = run({ signal: AbortSignal.timeout(100), readDecimals: () => new Promise<number>((resolve) => { answer = resolve; }) });
    expect(await late).toMatchObject({ status: "refused", code: "DECIMALS_UNAVAILABLE" });
    answer(6);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await run({ now: () => NOW + 60_000, readDecimals: async () => { throw new Error("not asked again"); } }))
      .toMatchObject({ status: "accepted" });
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

  it("rate limit: the run claims its slot first; an unclaimed run (another one within 20 seconds) asks nothing outside", async () => {
    await run();
    expect(claims).toEqual([{ p_network: "devnet", p_payment_mint: DEVNET_USDC }]);
    fetched.length = 0;
    db.ref!.rpcs.claim_fx_auto_run = () => ({ claimed: false });
    expect(await run({ now: () => NOW + 60_000 })).toEqual({ status: "skipped", network: "devnet", reason: "THROTTLED" });
    expect(fetched).toEqual([]);
    expect(written).toHaveLength(1);
  });

  it("concurrent calls: only the one that claims asks the sources", async () => {
    let slot = true;
    db.ref!.rpcs.claim_fx_auto_run = () => {
      const claimed = slot;
      slot = false;
      return { claimed };
    };
    const results = await Promise.all(Array.from({ length: 5 }, () => run()));
    expect(results.filter((r) => r.status === "accepted")).toHaveLength(1);
    expect(results.filter((r) => r.status === "skipped" && r.reason === "THROTTLED")).toHaveLength(4);
    expect(fetched.filter((u) => u === FX_SOURCES[0].url)).toHaveLength(1);
  });

  it("a write the database throttled after all (its own window) is skipped, never reported as decided", async () => {
    db.ref!.rpcs.record_fx_auto_rate = () => ({ written: false, throttled: true });
    expect(await run()).toEqual({ status: "skipped", network: "devnet", reason: "THROTTLED" });
    overrides[FX_SOURCES[0].url] = () => json({ error: [], result: { USDCEUR: { a: ["0.95"], b: ["0.949"] } } });
    db.ref!.rpcs.record_fx_auto_refusal = () => ({ written: false, throttled: true });
    expect(await run({ now: () => NOW + 60_000 })).toEqual({ status: "skipped", network: "devnet", reason: "THROTTLED" });
  });

  it("values the database's CHECKs refuse (23514) are a refusal, INVALID_FX_RATE, recorded where possible; never DB_ERROR", async () => {
    const violation = (code = "23514", message = 'new row for relation "fx_auto_rates" violates check constraint "fx_auto_rates_eur_per_token_bounds"') =>
      Object.assign(new Error(message), { code });
    db.ref!.rpcs.record_fx_auto_rate = (args) => {
      written.push(args);
      throw violation();
    };
    // The rate is refused by the database: recorded as a refusal with the rate it refused.
    expect(await run()).toMatchObject({ status: "refused", network: "devnet", paymentMint: DEVNET_USDC, code: "INVALID_FX_RATE" });
    expect(written).toHaveLength(1);
    expect(refused).toEqual([expect.objectContaining({
      p_network: "devnet", p_payment_mint: DEVNET_USDC, p_code: "INVALID_FX_RATE",
      p_quotes: expect.objectContaining({ refused_rate: "0.88895", median: "0.88895", ecb_tolerance_bps: 250 }),
    })]);
    // The writer's own input check (P0001 INVALID_FX_RATE) means the same; another P0001 does not.
    db.ref!.rpcs.record_fx_auto_rate = () => { throw violation("P0001", "INVALID_FX_RATE"); };
    expect(await run({ now: () => NOW + 60_000 })).toMatchObject({ status: "refused", code: "INVALID_FX_RATE" });
    db.ref!.rpcs.record_fx_auto_rate = () => { throw violation("P0001", "INVALID_NETWORK"); };
    expect(await run({ now: () => NOW + 120_000 })).toEqual({ status: "failed", network: "devnet", error: "DB_ERROR" });

    // The refusal refused too: answered failed INVALID_FX_RATE (503, the code in fx_http_runs), not DB_ERROR.
    db.ref!.rpcs.record_fx_auto_rate = () => { throw violation(); };
    db.ref!.rpcs.record_fx_auto_refusal = () => { throw violation("23514", "violates check constraint"); };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await run({ now: () => NOW + 180_000 })).toEqual({ status: "failed", network: "devnet", error: "INVALID_FX_RATE" });
    expect(error.mock.calls.flat().join(" ")).toContain("INVALID_FX_RATE");

    // A refusal (here ECB_UNAVAILABLE) whose recording a CHECK refuses is recorded once more as INVALID_FX_RATE.
    const codes: unknown[] = [];
    db.ref!.rpcs.record_fx_auto_refusal = (args) => {
      codes.push(args.p_code);
      if (args.p_code !== "INVALID_FX_RATE") throw violation();
      return { written: true, throttled: false };
    };
    overrides[ECB_DAILY_XML_URL] = () => new Response("", { status: 503 });
    clearFxCaches();
    expect(await run({ now: () => NOW + 240_000 })).toMatchObject({ status: "refused", code: "INVALID_FX_RATE" });
    expect(codes).toEqual(["ECB_UNAVAILABLE", "INVALID_FX_RATE"]);

    // Through the route: refused is a decision (200); the unrecordable case is a 503 naming the code.
    vi.useFakeTimers({ toFake: ["Date"], now: NOW + 300_000 });
    vi.stubGlobal("fetch", fakeFetch);
    vi.stubEnv("RETRY_WORKER_SECRET", SECRET);
    db.ref!.rpcs.record_fx_auto_refusal = () => { throw violation(); };
    const res = await internalFx(new Request("https://manci.test/api/internal/fx", { method: "POST", headers: { authorization: `Bearer ${SECRET}` } }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, data: { status: "failed", error: "INVALID_FX_RATE" } });
    vi.useRealTimers();
  });

  it("before 0080, or with the database down, the run fails without asking anyone", async () => {
    delete db.ref!.rpcs.claim_fx_auto_run;
    expect(await run()).toEqual({ status: "failed", network: "devnet", error: "NOT_INSTALLED" });
    db.ref!.rpcs.claim_fx_auto_run = () => { throw new Error("connection refused"); };
    expect(await run()).toEqual({ status: "failed", network: "devnet", error: "DB_ERROR" });
    expect(fetched).toEqual([]);
    installRpcs();
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

  it("audits every manual write on the server: kind, rate, max age, override, the row it replaced, the fresh automatic rate and the gap", async () => {
    const audits = () => db.ref!.rows("audit_events");
    const autoRow = (msAgo: number) => ({ network: "devnet", payment_mint: DEVNET_USDC, eur_per_token: "0.88895", decimals: 6,
      source: "auto: median of kraken, coinbase", quotes: {}, as_of: iso(msAgo), max_age: "00:15:00" });
    db.ref!.tables.fx_auto_rates = [autoRow(60_000)];
    const rate = { op: "upsert", payment_mint: DEVNET_USDC, kind: "rate", eur_per_token: "0.95", source: "Bank quote", max_age_days: 2 };
    expect((await call({ ...rate, override_auto: true }, "adminConfig.fxRatesWrite")).status).toBe(200);
    expect(audits()).toEqual([expect.objectContaining({
      network: "devnet", ix_name: "fx_rate_update", category: "launchpad", actor_wallet: signer.wallet, target_label: DEVNET_USDC,
      status: "success", reason: expect.stringMatching(/override of the automatic rate: 0\.95 EUR$/),
      metadata: expect.objectContaining({
        network: "devnet", payment_mint: DEVNET_USDC, op: "upsert", kind: "rate", eur_per_token: "0.95", decimals: 6, source: "Bank quote",
        max_age_days: 2, override_auto: true, override_column_written: true, rows_read: true, previous: null,
        auto_fresh: { eur_per_token: "0.88895", as_of: expect.any(String) }, auto_deviation_pct: 6.87,
        actor_verified: true, actor_source: "siws-signature",
      }),
    })]);

    // A stale automatic rate counts for nothing: no fresh rate, no gap. The replaced manual row is recorded.
    db.ref!.tables.fx_auto_rates = [autoRow(20 * 60_000)];
    expect((await call({ ...rate, eur_per_token: "0.9", override_auto: false }, "adminConfig.fxRatesWrite")).status).toBe(200);
    expect(audits()[1].metadata).toMatchObject({ eur_per_token: "0.9", override_auto: false, auto_fresh: null, auto_deviation_pct: null,
      previous: { kind: "rate", eur_per_token: "0.95", override_auto: true, max_age: "2 days" } });

    // A delete is a manual write too.
    expect((await call({ op: "delete", payment_mint: DEVNET_USDC }, "adminConfig.fxRatesWrite")).status).toBe(200);
    expect(audits()[2]).toMatchObject({ ix_name: "fx_rate_delete", target_label: DEVNET_USDC,
      metadata: { op: "delete", rows_read: true, previous: { eur_per_token: "0.95" } } });

    // The rate row is written first: a failed audit insert is logged, not answered as a failed write (as treasury-revalue).
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    db.ref!.failWrites.add("audit_events");
    expect((await call({ ...rate, override_auto: false }, "adminConfig.fxRatesWrite")).status).toBe(200);
    expect(db.ref!.rows("fx_rates").some((r) => r.eur_per_token === "0.95")).toBe(true);
    expect(error.mock.calls.flat().join(" ")).toContain("[api/admin-config/fx-rates] audit row not written");
    // Read-only calls write no audit row.
    db.ref!.failWrites.clear();
    const count = audits().length;
    expect((await call({})).status).toBe(200);
    expect(audits()).toHaveLength(count);
  });

  it("a front ahead of 0080: what /admin/limits sends (override_auto false) is saved without the column; an override waits for 0080", async () => {
    db.ref!.missingColumns.fx_rates = ["override_auto"];
    db.ref!.failReads.add("fx_auto_rates");
    db.ref!.readErrorCodes.fx_auto_rates = "42P01";
    const rate = { op: "upsert", payment_mint: DEVNET_USDC, kind: "rate", eur_per_token: "0.95", source: "Bank quote", max_age_days: 7 };
    let r = await call({ ...rate, override_auto: false }, "adminConfig.fxRatesWrite");
    expect(r.status).toBe(200);
    expect(db.ref!.rows("fx_rates")).toHaveLength(1);
    expect(db.ref!.rows("fx_rates")[0]).toMatchObject({ payment_mint: DEVNET_USDC, eur_per_token: "0.95", source: "Bank quote" });
    expect(db.ref!.rows("fx_rates")[0]).not.toHaveProperty("override_auto");
    expect(r.body.data![0]).toMatchObject({ origin: "manual", eur_per_token: "0.95" });
    db.ref!.tables.fx_rates = [];
    r = await call({ ...rate, override_auto: true }, "adminConfig.fxRatesWrite");
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/0080/);
    expect(db.ref!.rows("fx_rates")).toHaveLength(0);
    // A peg sends no override: saved as before.
    r = await call({ ...rate, payment_mint: PLAIN, kind: "eur_peg", override_auto: false }, "adminConfig.fxRatesWrite");
    expect(r.status).toBe(200);
    // Any other write error is still a 500.
    db.ref!.failWrites.add("fx_rates");
    r = await call({ ...rate, override_auto: false }, "adminConfig.fxRatesWrite");
    expect(r.status).toBe(500);
  });
});
