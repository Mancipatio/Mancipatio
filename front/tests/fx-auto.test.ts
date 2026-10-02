// Migration 0080, the automatic EUR rate: the pure parts.
//   - lib/fx-auto.ts parses the four public USDC/EUR sources and the ECB
//     daily XML (fixtures: real answers saved on 2026-10-02 in
//     tests/fixtures/fx/), and aggregates them: the median, refused on fewer
//     than two sources, on a spread above 1 % or 2 % away from the ECB;
//   - lib/fx-effective.ts picks the rate that counts (the same rule as SQL
//     public.fx_effective_rate, tests/fx-auto-rates.postgres.test.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FX_SOURCES, FxParseError, aggregateFx, autoFxMint, autoSourceText, bookMid, median, parseEcbDailyXml, rateText,
  type FxQuote, type FxSourceId,
} from "@/lib/fx-auto";
import { fxRowFresh, resolveFxRate, resolveFxRates, type FxAutoRow, type FxManualRow } from "@/lib/fx-effective";
import { USDC } from "@/lib/payment-mints";

const fixture = (name: string) => readFileSync(join(process.cwd(), "tests/fixtures/fx", name), "utf8");
const source = (id: FxSourceId) => FX_SOURCES.find((s) => s.id === id)!;
const NOW = Date.parse("2026-10-02T20:40:00Z");
const ECB = { date: "2026-10-02", usdPerEur: 1.1225 };
const quotes = (...rates: number[]): FxQuote[] =>
  rates.map((rate, i) => ({ source: FX_SOURCES[i % FX_SOURCES.length].id, rate }));

describe("source parsers (real answers of 2026-10-02)", () => {
  it.each<[FxSourceId, string, number]>([
    ["kraken", "kraken-usdceur.json", (0.8889 + 0.889) / 2],
    ["coinbase", "coinbase-usdc-eur.json", (0.8889 + 0.889) / 2],
    ["bitstamp", "bitstamp-usdceur.json", (0.88891 + 0.88905) / 2],
    ["bitvavo", "bitvavo-usdc-eur.json", (0.8888 + 0.8889) / 2],
  ])("%s: the mid of the best bid and ask", (id, file, expected) => {
    expect(source(id).parse(JSON.parse(fixture(file)))).toBeCloseTo(expected, 12);
  });

  it("refuses an error answer, another pair, a missing field or a non-decimal price", () => {
    const bad: Array<[FxSourceId, unknown]> = [
      ["kraken", { error: ["EQuery:Unknown asset pair"], result: {} }],
      ["kraken", { error: [], result: { USDTEUR: { a: ["0.9"], b: ["0.9"] } } }],
      ["coinbase", { message: "NotFound" }],
      ["coinbase", { bid: 0.889, ask: 0.889 }],
      ["bitstamp", { bid: "0.88e0", ask: "0.889" }],
      ["bitvavo", { market: "USDT-EUR", bid: "0.9", ask: "0.9" }],
      ["bitvavo", null],
      ["bitvavo", []],
    ];
    for (const [id, body] of bad) expect(() => source(id).parse(body), `${id} ${JSON.stringify(body)}`).toThrow(FxParseError);
  });

  it("refuses a crossed or absurdly wide book and a price outside 0.2–5 EUR per USDC", () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        return (err as FxParseError).code;
      }
      return null;
    };
    expect(code(() => bookMid("0.90", "0.89"))).toBe("CROSSED_BOOK");
    expect(code(() => bookMid("0.85", "0.89"))).toBe("CROSSED_BOOK");
    expect(code(() => bookMid("0.1", "0.1"))).toBe("OUT_OF_RANGE");
    expect(code(() => bookMid("8", "8.01"))).toBe("OUT_OF_RANGE");
    expect(code(() => bookMid("0", "0.889"))).toBe("PARSE_ERROR");
    expect(bookMid("0.889", "0.889")).toBe(0.889);
  });

  it("every source is a keyless public HTTPS endpoint", () => {
    expect(FX_SOURCES.map((s) => s.id)).toEqual(["kraken", "coinbase", "bitstamp", "bitvavo"]);
    for (const s of FX_SOURCES) {
      expect(s.url).toMatch(/^https:\/\//);
      expect(s.url).not.toMatch(/key|token|secret/i);
    }
  });
});

describe("ECB daily XML", () => {
  it("reads the USD reference rate and its date", () => {
    expect(parseEcbDailyXml(fixture("ecb-eurofxref-daily.xml"))).toEqual({ date: "2026-10-02", usdPerEur: 1.1225 });
    expect(parseEcbDailyXml(`<Cube><Cube time="2026-09-30"><Cube currency="USD" rate="1.0811"/></Cube></Cube>`))
      .toEqual({ date: "2026-09-30", usdPerEur: 1.0811 });
  });

  it("refuses a file without the date or the USD rate, or an absurd rate", () => {
    for (const xml of [
      "<html>maintenance</html>",
      "<Cube><Cube time='2026-10-02'><Cube currency='JPY' rate='176.99'/></Cube></Cube>",
      "<Cube><Cube currency='USD' rate='1.1225'/></Cube>",
      "<Cube><Cube time='2026-10-02'><Cube currency='USD' rate='1.1.2'/></Cube></Cube>",
      "<Cube><Cube time='2026-10-02'><Cube currency='USD' rate='100'/></Cube></Cube>",
    ]) {
      expect(() => parseEcbDailyXml(xml), xml).toThrow(FxParseError);
    }
  });
});

describe("aggregation", () => {
  it("takes the median of the usable sources and anchors it on the ECB (the fixtures of 2026-10-02)", () => {
    const real = FX_SOURCES.map((s, i) => ({
      source: s.id,
      rate: s.parse(JSON.parse(fixture(["kraken-usdceur.json", "coinbase-usdc-eur.json", "bitstamp-usdceur.json", "bitvavo-usdc-eur.json"][i]))),
    }));
    const result = aggregateFx(real, parseEcbDailyXml(fixture("ecb-eurofxref-daily.xml")), NOW);
    expect(result).toMatchObject({ ok: true, rate: "0.88895", code: null, spreadBps: 1, ecbDeviationBps: 22 });
    expect(result.used).toEqual(["kraken", "coinbase", "bitstamp", "bitvavo"]);
    expect(result.ecbRate).toBeCloseTo(1 / 1.1225, 12);
  });

  it("median of an odd and an even count; the rate has at most 10 decimals", () => {
    expect(median([0.9, 0.88, 0.89])).toBe(0.89);
    expect(median([0.88, 0.9, 0.89, 0.91])).toBeCloseTo(0.895, 12);
    expect(rateText(0.8890123456789)).toBe("0.8890123457");
    expect(rateText(1)).toBe("1");
    expect(aggregateFx(quotes(0.89, 0.8901, 0.8902), ECB, NOW).rate).toBe("0.8901");
  });

  it("ignores failed sources but needs at least two usable ones", () => {
    const two: FxQuote[] = [{ source: "kraken", rate: 0.889 }, { source: "coinbase", error: "TIMEOUT" },
      { source: "bitstamp", rate: 0.8892 }, { source: "bitvavo", error: "HTTP_ERROR" }];
    expect(aggregateFx(two, ECB, NOW)).toMatchObject({ ok: true, rate: "0.8891", used: ["kraken", "bitstamp"] });
    const one: FxQuote[] = [{ source: "kraken", rate: 0.889 }, { source: "coinbase", error: "TIMEOUT" },
      { source: "bitstamp", error: "PARSE_ERROR" }, { source: "bitvavo", rate: 7 }];
    expect(aggregateFx(one, ECB, NOW)).toMatchObject({ ok: false, code: "TOO_FEW_SOURCES", rate: null, used: ["kraken"] });
    expect(aggregateFx([], ECB, NOW)).toMatchObject({ ok: false, code: "TOO_FEW_SOURCES" });
  });

  it("refuses sources that disagree by more than 1 %, whatever the ECB says", () => {
    // 0.880 vs 0.890: 1.13 % of the median.
    expect(aggregateFx(quotes(0.88, 0.889, 0.89), ECB, NOW)).toMatchObject({ ok: false, code: "SOURCE_DIVERGENCE", spreadBps: 112 });
    // Exactly 1 % is still accepted.
    expect(aggregateFx(quotes(0.885, 0.88945, 0.89385), ECB, NOW).ok).toBe(true);
  });

  it("refuses without a usable ECB anchor (missing, older than 6 days, or from the future)", () => {
    expect(aggregateFx(quotes(0.889, 0.8891), null, NOW)).toMatchObject({ ok: false, code: "ECB_UNAVAILABLE", median: 0.88905 });
    // Easter: Thursday's rate is still the anchor the next Tuesday morning.
    const thursday = { date: "2026-09-27", usdPerEur: 1.1225 };
    expect(aggregateFx(quotes(0.889, 0.8891), thursday, Date.parse("2026-10-02T08:00:00Z")).ok).toBe(true);
    expect(aggregateFx(quotes(0.889, 0.8891), { date: "2026-09-25", usdPerEur: 1.1225 }, NOW))
      .toMatchObject({ ok: false, code: "ECB_STALE" });
    expect(aggregateFx(quotes(0.889, 0.8891), { date: "2026-10-05", usdPerEur: 1.1225 }, NOW))
      .toMatchObject({ ok: false, code: "ECB_STALE" });
  });

  it("refuses a median more than 2 % away from the ECB rate (a USDC depeg or broken sources)", () => {
    // ECB: 0.8909 EUR per USD; a USDC at 0.97 USD is 0.8642 EUR (−3 %).
    const depeg = aggregateFx(quotes(0.8642, 0.8645, 0.864), ECB, NOW);
    expect(depeg).toMatchObject({ ok: false, code: "ECB_DEVIATION", rate: null });
    expect(depeg.ecbDeviationBps).toBe(299);
    // 1.9 % away is accepted.
    expect(aggregateFx(quotes(0.874, 0.8741), ECB, NOW).ok).toBe(true);
  });

  it("names its sources and the anchor in the fx_rates source text (at most 200 characters)", () => {
    expect(autoSourceText(["kraken", "bitstamp"], ECB)).toBe("auto: median of kraken, bitstamp (ECB 2026-10-02: 1.1225 USD/EUR)");
    expect(autoSourceText(["kraken", "coinbase", "bitstamp", "bitvavo"], ECB).length).toBeLessThanOrEqual(200);
  });

  it("keeps a rate for the network's USDC only: mainnet and devnet alike, nothing on testnet and localnet", () => {
    expect(autoFxMint("mainnet")).toBe(USDC.mainnet!.mint);
    expect(autoFxMint("devnet")).toBe(USDC.devnet!.mint);
    expect(autoFxMint("testnet")).toBeNull();
    expect(autoFxMint("localnet")).toBeNull();
  });
});

describe("the rate that counts (lib/fx-effective.ts = SQL fx_effective_rate)", () => {
  const MINT = USDC.devnet!.mint;
  const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
  const manual = (ageSeconds: number, over: Partial<FxManualRow> = {}): FxManualRow => ({
    payment_mint: MINT, kind: "rate", eur_per_token: "0.9", decimals: 6, source: "ECB", as_of: ago(ageSeconds), max_age: "7 days",
    updated_by: "Admin111", ...over,
  });
  const auto = (ageSeconds: number): FxAutoRow => ({
    payment_mint: MINT, eur_per_token: "0.889", decimals: 6, source: "auto: median of kraken, coinbase", as_of: ago(ageSeconds),
    max_age: "00:15:00",
  });

  it("a fresh automatic rate counts over a fresh manual one, in the fx_rates shape", () => {
    expect(resolveFxRate(manual(60), auto(60), NOW)).toEqual({
      origin: "auto", fresh: true,
      row: expect.objectContaining({ kind: "rate", eur_per_token: "0.889", max_age: "00:15:00", updated_by: "fx-auto", override_auto: false }),
    });
  });

  it("a stale automatic rate falls back to a fresh manual one", () => {
    expect(resolveFxRate(manual(86_400), auto(16 * 60), NOW)).toMatchObject({ origin: "manual", fresh: true, row: { eur_per_token: "0.9" } });
  });

  it("an override or an eur_peg row counts whatever the automatic rate says (an override can itself go stale)", () => {
    expect(resolveFxRate(manual(60, { override_auto: true }), auto(60), NOW)).toMatchObject({ origin: "manual_override", fresh: true });
    expect(resolveFxRate(manual(8 * 86_400, { override_auto: true }), auto(60), NOW)).toMatchObject({ origin: "manual_override", fresh: false });
    expect(resolveFxRate(manual(400 * 86_400, { kind: "eur_peg", eur_per_token: "1" }), auto(60), NOW))
      .toMatchObject({ origin: "manual", fresh: true, row: { kind: "eur_peg" } });
  });

  it("nothing fresh: the most recently observed rate (manual on a tie), stale; neither: none", () => {
    expect(resolveFxRate(manual(8 * 86_400), auto(3600), NOW)).toMatchObject({ origin: "auto", fresh: false });
    expect(resolveFxRate(manual(3600 * 2, { max_age: "01:00:00" }), auto(3600 * 3), NOW)).toMatchObject({ origin: "manual", fresh: false });
    expect(resolveFxRate(manual(3600, { max_age: "00:30:00" }), auto(3600), NOW)).toMatchObject({ origin: "manual", fresh: false });
    expect(resolveFxRate(null, auto(3600), NOW)).toMatchObject({ origin: "auto", fresh: false });
    expect(resolveFxRate(null, null, NOW)).toBeNull();
  });

  it("an unreadable max age or kind is never fresh", () => {
    expect(fxRowFresh({ kind: "rate", as_of: ago(1), max_age: "soon" }, NOW)).toBe(false);
    expect(fxRowFresh({ kind: "other", as_of: ago(1), max_age: "7 days" }, NOW)).toBe(false);
    expect(fxRowFresh({ kind: "rate", as_of: "never", max_age: "7 days" }, NOW)).toBe(false);
    expect(fxRowFresh({ kind: "eur_peg", as_of: "never", max_age: "soon" }, NOW)).toBe(true);
  });

  it("per mint: a mint with only a manual row, one with only an automatic row, one with both", () => {
    const other = "So11111111111111111111111111111111111111112";
    const map = resolveFxRates([manual(60, { payment_mint: other, kind: "eur_peg", eur_per_token: "1" }), manual(60)], [auto(30)], NOW);
    expect([...map.keys()].sort()).toEqual([MINT, other].sort());
    expect(map.get(MINT)?.origin).toBe("auto");
    expect(map.get(other)?.row.kind).toBe("eur_peg");
    expect(resolveFxRates([], [auto(30)], NOW).get(MINT)?.origin).toBe("auto");
  });
});
