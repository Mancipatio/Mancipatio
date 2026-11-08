// Token migration (V1) ratio library (lib/token-migration/ratio.ts): the lot
// is the smallest nice integer at or above S_old / N_target, so the units cap
// never exceeds what the shareholders' decision E allows. Exhaustive fixtures
// (decimals 0/6/9/18, tiny and huge supplies up to u64::MAX, E = 1 and 10000
// bps, every preset granularity and custom ones from 100 to 10^12, a
// joint-stock company's number of shares) and the invariants on every one of
// them, including the rounded-and-marked percentages a person reads.
import { describe, expect, it } from "vitest";
import {
  computeMigrationRatio,
  DEFAULT_GRANULARITY,
  depositAmountFor,
  formatBaseUnits,
  formatEquityBps,
  formatParityPercent,
  formatPercentE4,
  formatUnits,
  isNiceLot,
  isValidGranularity,
  lotsFor,
  MAX_GRANULARITY,
  MIGRATION_GRANULARITIES,
  MIN_GRANULARITY,
  niceLotAtLeast,
  parseEquityPercent,
  parseGranularity,
  parseTokenAmount,
  percentClause,
  percentFigure,
  percentText,
  pow10,
  RatioInputError,
  U64_MAX,
  unitPercent,
  unitsForDeposit,
  type MigrationRatio,
  type PercentFigure,
} from "@/lib/token-migration/ratio";

const B = (v: number | string) => BigInt(v);
const ZERO = B(0);
const ONE = B(1);

/** Every nice number ({1, 2, 2.5, 5} × 10^n, integers) up to 10^digits, ascending. */
function niceNumbers(digits: number): bigint[] {
  const out: bigint[] = [];
  for (let n = 0; n <= digits; n++) {
    const p = pow10(n);
    out.push(p, B(2) * p);
    if (n >= 1) out.push((B(25) * p) / B(10));
    out.push(B(5) * p);
  }
  return [...new Set(out)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * A percent figure is part / whole × 100 rounded to its last shown digit, and
 * "exact" only when nothing was dropped (every digit checked in bigint).
 */
function checkFigure(figure: PercentFigure, part: bigint, whole: bigint, minDecimals = 4) {
  const [intPart, fraction = ""] = figure.text.replace(/,/g, "").split(".");
  expect(fraction.length >= minDecimals, `${figure.text}: at least ${minDecimals} decimals`).toBe(true);
  const error = B(intPart + fraction) * whole - part * B(100) * pow10(fraction.length);
  expect(B(2) * (error < ZERO ? -error : error) <= whole, `${figure.text}: rounded to its last digit`).toBe(true);
  expect(figure.exact, `${figure.text}: exact only when nothing was dropped`).toBe(error === ZERO);
}

/** The invariants every ratio must satisfy. */
function checkInvariants(r: MigrationRatio) {
  const label = `S=${r.qualifiedSupply} E=${r.equityBps} G=${r.granularity}`;
  // L ≥ rawLot ⟺ L × N_target ≥ S_old.
  expect(r.lot * r.targetUnits >= r.qualifiedSupply, `${label}: L ≥ rawLot`).toBe(true);
  // L is the SMALLEST nice number ≥ rawLot: the nice number below it is < rawLot.
  const below = niceNumbers(r.lot.toString().length).filter((x) => x < r.lot);
  if (below.length > 0) {
    const previous = below[below.length - 1];
    expect(previous * r.targetUnits < r.qualifiedSupply, `${label}: L is the smallest nice lot`).toBe(true);
  } else {
    expect(r.lot).toBe(ONE);
  }
  expect(isNiceLot(r.lot), `${label}: L is nice`).toBe(true);
  expect(r.lot >= ONE).toBe(true);
  expect(r.unitsCap <= r.targetUnits, `${label}: N_eff ≤ N_target`).toBe(true);
  expect(r.unitsCap * r.lot <= r.qualifiedSupply, `${label}: N_eff × L ≤ S_old`).toBe(true);
  expect((r.unitsCap + ONE) * r.lot > r.qualifiedSupply, `${label}: N_eff = floor(S_old / L)`).toBe(true);
  // E_eff ≤ E, exactly: N_eff × 10000 ≤ E × G.
  expect(r.unitsCap * B(10_000) <= B(r.equityBps) * r.granularity, `${label}: E_eff ≤ E`).toBe(true);
  expect(r.effectivePercentE4 <= r.equityPercentE4, `${label}: E_eff% ≤ E%`).toBe(true);
  checkFigure(r.effectiveShare, r.unitsCap, r.granularity);
  expect(r.targetUnits).toBe((B(r.equityBps) * r.granularity) / B(10_000));
  expect(r.qualifiedSupply).toBe(r.oldTotalSupply - r.excludedAmount);
}

/** xorshift64*: deterministic fixtures, no Math.random. */
function rng(seed: bigint) {
  let x = seed;
  const mask = (ONE << B(64)) - ONE;
  return () => {
    x ^= x >> B(12);
    x ^= (x << B(25)) & mask;
    x ^= x >> B(27);
    return (x * B("2685821657736338717")) & mask;
  };
}

describe("niceLotAtLeast", () => {
  it("is the smallest nice integer at or above the target, for every target up to 100,000", () => {
    const nice = niceNumbers(6);
    let j = 0;
    for (let t = 1; t <= 100_000; t++) {
      const target = B(t);
      while (nice[j] < target) j++;
      expect(niceLotAtLeast(target)).toBe(nice[j]);
    }
  });

  it("knows the integer candidates: 2.5 only from 25 up, and 1 below 1", () => {
    expect(niceLotAtLeast(ZERO)).toBe(ONE);
    expect(niceLotAtLeast(B(-5))).toBe(ONE);
    expect([1, 2, 3, 5, 6, 10, 11, 21, 25, 26, 51, 99, 101].map((n) => niceLotAtLeast(B(n)).toString())).toEqual(
      ["1", "2", "5", "5", "10", "10", "20", "25", "25", "50", "100", "100", "200"],
    );
    expect(isNiceLot(B(25))).toBe(true);
    expect(isNiceLot(B(3))).toBe(false);
    expect(isNiceLot(ZERO)).toBe(false);
    // u64::MAX ≈ 1.84 × 10^19: the next nice number is 2 × 10^19.
    expect(niceLotAtLeast(U64_MAX)).toBe(B(2) * pow10(19));
  });
});

describe("computeMigrationRatio: the worked example of the report (section 5)", () => {
  it.each([0, 6, 9])("1e9 total, 4e8 excluded, E 12 %%, G 1e6 → N_target 120,000, lot 5,000 whole tokens (decimals %i)", (decimals) => {
    const whole = pow10(decimals);
    const r = computeMigrationRatio({
      oldTotalSupply: B(1_000_000_000) * whole,
      excludedAmount: B(400_000_000) * whole,
      equityBps: 1200,
      granularity: B(1_000_000),
      decimals,
      marketCap: 8_580_000,
      valuation: 60_000_000,
    });
    checkInvariants(r);
    expect(r.qualifiedSupply).toBe(B(600_000_000) * whole);
    expect(r.targetUnits).toBe(B(120_000));
    expect(r.lot).toBe(B(5_000) * whole);
    expect(formatBaseUnits(r.lot, decimals)).toBe("5,000");
    expect(r.unitsCap).toBe(B(120_000));
    expect(formatPercentE4(r.effectivePercentE4)).toBe("12.0000");
    expect(r.warnings).toEqual([]);
    expect(formatParityPercent(r.parityPercent)).toBe("14.3");
    // The report's holders: 2,500,000 OLD → 500 units; 12,345 OLD → 2 lots (the rest stays with the holder).
    expect(unitsForDeposit(B(2_500_000) * whole, r.lot)).toBe(B(500));
    expect(lotsFor(B(12_345) * whole, r.lot)).toBe(B(2));
    expect(unitsForDeposit(B(12_345) * whole, r.lot)).toBeNull();
    expect(unitsForDeposit(depositAmountFor(B(2), r.lot), r.lot)).toBe(B(2));
  });

  it("defaults to G = 1,000,000 (owner decision)", () => {
    expect(DEFAULT_GRANULARITY).toBe(B(1_000_000));
    const r = computeMigrationRatio({ oldTotalSupply: B(1_000_000_000), excludedAmount: ZERO, equityBps: 1000, decimals: 0 });
    expect(r.granularity).toBe(DEFAULT_GRANULARITY);
    expect(r.targetUnits).toBe(B(100_000));
    expect(r.lot).toBe(B(10_000));
  });
});

describe("computeMigrationRatio: fixtures", () => {
  const supplies = [
    ONE, B(2), B(7), B(999), B(10_000), B(123_456_789), B("1000000000000"), B("999999999999999999"), U64_MAX - ONE, U64_MAX,
  ];
  const equities = [1, 2, 99, 100, 1200, 2500, 3333, 9999, 10_000];

  it("satisfies every invariant on the grid of supplies × E × G × decimals", () => {
    let count = 0;
    for (const supply of supplies) {
      for (const excludedShare of [0, 1, 50, 99]) {
        const excluded = (supply * B(excludedShare)) / B(100);
        if (excluded >= supply) continue;
        for (const equityBps of equities) {
          for (const granularity of MIGRATION_GRANULARITIES) {
            for (const decimals of [0, 6, 9, 18]) {
              const r = computeMigrationRatio({ oldTotalSupply: supply, excludedAmount: excluded, equityBps, granularity, decimals });
              checkInvariants(r);
              count++;
            }
          }
        }
      }
    }
    expect(count).toBeGreaterThan(5_000);
  });

  it("satisfies every invariant on 4,000 pseudo-random inputs", () => {
    const next = rng(B("88172645463325252"));
    for (let i = 0; i < 4_000; i++) {
      const digits = Number(next() % B(20)) + 1;
      const supply = (next() % pow10(digits)) + ONE;
      const clamped = supply > U64_MAX ? U64_MAX : supply;
      const excluded = clamped > ONE ? next() % clamped : ZERO;
      const equityBps = Number(next() % B(10_000)) + 1;
      const granularity = MIGRATION_GRANULARITIES[Number(next() % B(4))];
      const decimals = Number(next() % B(19));
      checkInvariants(computeMigrationRatio({ oldTotalSupply: clamped, excludedAmount: excluded, equityBps, granularity, decimals }));
    }
  });

  it("satisfies every invariant with a custom G on the grid, and refuses an E below one unit of it", () => {
    const customs = [B(100), B(101), B(337), B(9_999), B(37_000), B(50_000), B(123_456_789), B("999999999989"), pow10(12)];
    let count = 0;
    for (const supply of supplies) {
      for (const equityBps of equities) {
        for (const granularity of customs) {
          const input = { oldTotalSupply: supply, excludedAmount: ZERO, equityBps, granularity, decimals: 6 };
          if (B(equityBps) * granularity < B(10_000)) {
            expect(() => computeMigrationRatio(input)).toThrow(RatioInputError);
            continue;
          }
          checkInvariants(computeMigrationRatio(input));
          checkFigure(unitPercent(granularity), ONE, granularity, 0);
          count++;
        }
      }
    }
    expect(count).toBeGreaterThan(500);
  });

  it("satisfies every invariant on 4,000 pseudo-random custom G from 100 to 10^12", () => {
    const next = rng(B("5165161616161"));
    const span = MAX_GRANULARITY - MIN_GRANULARITY + ONE;
    for (let i = 0; i < 4_000; i++) {
      const digits = Number(next() % B(20)) + 1;
      const supply = (next() % pow10(digits)) + ONE;
      const clamped = supply > U64_MAX ? U64_MAX : supply;
      const excluded = clamped > ONE ? next() % clamped : ZERO;
      const equityBps = Number(next() % B(10_000)) + 1;
      // Half the draws over the whole range, half among small share counts.
      const granularity = MIN_GRANULARITY + (i % 2 === 0 ? next() % span : next() % B(100_000));
      const input = { oldTotalSupply: clamped, excludedAmount: excluded, equityBps, granularity, decimals: Number(next() % B(19)) };
      if (B(equityBps) * granularity < B(10_000)) expect(() => computeMigrationRatio(input)).toThrow(RatioInputError);
      else checkInvariants(computeMigrationRatio(input));
    }
  });

  it("E = 1 bps on the smallest granularity: one unit, the whole qualified supply as its lot (rounded up to nice)", () => {
    const r = computeMigrationRatio({ oldTotalSupply: B(1_000_000), excludedAmount: ZERO, equityBps: 1, granularity: B(10_000), decimals: 0 });
    expect(r.targetUnits).toBe(ONE);
    expect(r.lot).toBe(B(1_000_000));
    expect(r.unitsCap).toBe(ONE);
    expect(formatPercentE4(r.effectivePercentE4)).toBe("0.0100");
    expect(r.warnings.map((w) => w.code)).toEqual(["few_units"]);
    // A supply just above a nice number with N_target = 1: the lot rounds up past the whole
    // supply and no unit could be delivered. Only that is said (the routes refuse such a draft).
    const odd = computeMigrationRatio({ oldTotalSupply: B(1_000_001), excludedAmount: ZERO, equityBps: 1, granularity: B(10_000), decimals: 0 });
    expect(odd.lot).toBe(B(2_000_000));
    expect(odd.unitsCap).toBe(ZERO);
    expect(odd.warnings.map((w) => w.code)).toEqual(["no_units"]);
    checkInvariants(odd);
  });

  it("E = 10000 bps (100 %) with the largest granularity on a supply below N_target: a lot of 1 base unit", () => {
    const r = computeMigrationRatio({ oldTotalSupply: B(5_000), excludedAmount: ZERO, equityBps: 10_000, granularity: B(10_000_000), decimals: 0 });
    expect(r.targetUnits).toBe(B(10_000_000));
    expect(r.lot).toBe(ONE);
    expect(r.unitsCap).toBe(B(5_000));
    expect(formatPercentE4(r.effectivePercentE4)).toBe("0.0500");
    expect(r.warnings.map((w) => w.code)).toEqual(["equity_shortfall"]);
  });

  it("u64::MAX supply, 100 %, G = 10,000,000: still exact", () => {
    const r = computeMigrationRatio({ oldTotalSupply: U64_MAX, excludedAmount: ZERO, equityBps: 10_000, granularity: B(10_000_000), decimals: 9 });
    checkInvariants(r);
    expect(r.lot).toBe(B("2000000000000"));
    expect(r.unitsCap).toBe(B(9_223_372));
  });
});

describe("computeMigrationRatio: a custom G (a joint-stock company's number of shares)", () => {
  // The worked example's supply (1e9 total, 4e8 excluded, E 12 %) on 50,000 and on 37,000 shares.
  const shares = (granularity: bigint, decimals: number) =>
    computeMigrationRatio({ oldTotalSupply: B(1_000_000_000) * pow10(decimals), excludedAmount: B(400_000_000) * pow10(decimals), equityBps: 1200, granularity, decimals });

  it.each([0, 9])("G = 50,000: N_target 6,000, lot 100,000 whole tokens, cap 6,000, E_eff exactly 12 %% (decimals %i)", (decimals) => {
    const r = shares(B(50_000), decimals);
    checkInvariants(r);
    expect(r.targetUnits).toBe(B(6_000));
    expect(r.rawLot).toEqual({ numerator: B(600_000_000) * pow10(decimals), denominator: B(6_000) });
    expect(r.lot).toBe(B(100_000) * pow10(decimals));
    expect(r.unitsCap).toBe(B(6_000));
    expect(r.effectivePercentE4).toBe(B(120_000));
    expect(r.effectiveShare).toEqual({ text: "12.0000", exact: true });
    expect(r.warnings).toEqual([]);
    // 100 / 50,000 ends: one unit is exactly 0.002 %, so nothing is marked.
    expect(unitPercent(r.granularity)).toEqual({ text: "0.002", exact: true });
    expect(percentClause(unitPercent(r.granularity))).toBe("= 0.002 %");
    expect(percentText(percentFigure(B(1_234), r.granularity))).toBe("2.4680");
  });

  it.each([0, 9])("G = 37,000: N_target 4,440, lot 200,000 whole tokens, cap 3,000, E_eff ≈ 8.1081 %% (decimals %i)", (decimals) => {
    const r = shares(B(37_000), decimals);
    checkInvariants(r);
    expect(r.targetUnits).toBe(B(4_440)); // 1200 × 37,000 / 10,000, exactly
    expect(r.rawLot).toEqual({ numerator: B(600_000_000) * pow10(decimals), denominator: B(4_440) });
    // ceil(600,000,000 / 4,440) = 135,136 whole tokens, rounded up to the next nice number.
    expect(r.lot).toBe(B(200_000) * pow10(decimals));
    expect(r.unitsCap).toBe(B(3_000));
    // E_eff = 3,000 / 37,000 = 8.108108… %: exact as a fraction, rounded only where a person reads it.
    expect(r.unitsCap * B(10_000) <= B(r.equityBps) * r.granularity).toBe(true);
    expect(r.effectivePercentE4).toBe(B(81_081));
    expect(r.effectiveShare).toEqual({ text: "8.1081", exact: false });
    expect(percentText(r.effectiveShare)).toBe("≈ 8.1081");
    expect(r.warnings.map((w) => w.code)).toEqual(["equity_shortfall"]);
    expect(r.warnings[0].text).toContain("leaves the holders ≈ 8.1081 % instead of the decided 12.0000 %");
    // One share is 1/37,000 of the company, 0.0027027… %.
    expect(unitPercent(r.granularity)).toEqual({ text: "0.0027", exact: false });
    expect(percentClause(unitPercent(r.granularity))).toBe("≈ 0.0027 %");
    // 4,440 shares are exactly 12 %: a round figure is not marked.
    expect(percentFigure(B(4_440), r.granularity)).toEqual({ text: "12.0000", exact: true });
  });

  it("few units also covers a joint-stock company with a small number of shares", () => {
    const r = computeMigrationRatio({ oldTotalSupply: B(1_000_000), excludedAmount: ZERO, equityBps: 10_000, granularity: B(500), decimals: 0 });
    expect(r.targetUnits).toBe(B(500));
    expect(r.lot).toBe(B(2_000));
    expect(r.unitsCap).toBe(B(500));
    expect(r.warnings.map((w) => w.code)).toEqual(["few_units"]);
    expect(r.warnings[0].text).toContain("Raise the granularity G; when G is a joint-stock company's number of shares, that takes a share split first.");
  });

  it("refuses an E that is less than one unit of a small G, naming the smallest E that works", () => {
    const base = { oldTotalSupply: B(1_000_000), excludedAmount: ZERO, decimals: 0 };
    expect(() => computeMigrationRatio({ ...base, equityBps: 33, granularity: B(300) })).toThrow("At G = 300 units, E = 0.33 % is less than one unit: E must be at least 0.34 %.");
    expect(() => computeMigrationRatio({ ...base, equityBps: 99, granularity: B(100) })).toThrow("E must be at least 1 %.");
    const r = computeMigrationRatio({ ...base, equityBps: 34, granularity: B(300) });
    expect(r.targetUnits).toBe(ONE);
    checkInvariants(r);
  });
});

describe("computeMigrationRatio: warnings", () => {
  it("few units: below 1,000 in the cap says to raise G", () => {
    const r = computeMigrationRatio({ oldTotalSupply: B(1_000_000), excludedAmount: ZERO, equityBps: 500, granularity: B(10_000), decimals: 0 });
    expect(r.unitsCap).toBe(B(500));
    expect(r.warnings[0]).toMatchObject({ code: "few_units" });
    expect(r.warnings[0].text).toContain("Raise the granularity G");
  });

  it("a lot of 2.5 whole tokens is flagged; a lot below one whole token is fine", () => {
    // S_old = 250,000 tokens of 6 decimals, N_target = 100,000 → rawLot 2.5 tokens.
    const flagged = computeMigrationRatio({ oldTotalSupply: B(250_000) * pow10(6), excludedAmount: ZERO, equityBps: 1000, granularity: B(1_000_000), decimals: 6 });
    expect(formatBaseUnits(flagged.lot, 6)).toBe("2.5");
    expect(flagged.warnings.map((w) => w.code)).toEqual(["lot_not_whole_tokens"]);
    expect(flagged.warnings[0].text).toContain("2.5 whole tokens");
    // rawLot 0.5 tokens: fine.
    const fine = computeMigrationRatio({ oldTotalSupply: B(50_000) * pow10(6), excludedAmount: ZERO, equityBps: 1000, granularity: B(1_000_000), decimals: 6 });
    expect(formatBaseUnits(fine.lot, 6)).toBe("0.5");
    expect(fine.warnings).toEqual([]);
  });

  it("equity shortfall: more than 5 % below E is flagged, 5 % or less is not", () => {
    // rawLot 1.2 → L 2 → N_eff halves.
    const short = computeMigrationRatio({ oldTotalSupply: B(120_000), excludedAmount: ZERO, equityBps: 1000, granularity: B(1_000_000), decimals: 0 });
    expect(short.lot).toBe(B(2));
    expect(short.unitsCap).toBe(B(60_000));
    expect(short.warnings.map((w) => w.code)).toEqual(["equity_shortfall"]);
    expect(short.warnings[0].text).toContain("6.0000 % instead of the decided 10.0000 %");
    // Exactly 5 % short: S_old = 95,000 × L with L = 1 → N_eff 95,000 of 100,000.
    const edge = computeMigrationRatio({ oldTotalSupply: B(95_000), excludedAmount: ZERO, equityBps: 1000, granularity: B(1_000_000), decimals: 0 });
    expect(edge.unitsCap).toBe(B(95_000));
    expect(edge.warnings).toEqual([]);
    const over = computeMigrationRatio({ oldTotalSupply: B(94_999), excludedAmount: ZERO, equityBps: 1000, granularity: B(1_000_000), decimals: 0 });
    expect(over.warnings.map((w) => w.code)).toEqual(["equity_shortfall"]);
  });

  it("the parity reference is display only and absent without both figures", () => {
    const base = { oldTotalSupply: B(1_000_000), excludedAmount: ZERO, equityBps: 1000, decimals: 0 };
    expect(computeMigrationRatio(base).parityPercent).toBeNull();
    expect(computeMigrationRatio({ ...base, marketCap: 1, valuation: 0 }).parityPercent).toBeNull();
    expect(computeMigrationRatio({ ...base, marketCap: Number.NaN, valuation: 5 }).parityPercent).toBeNull();
    const withParity = computeMigrationRatio({ ...base, marketCap: 250_000, valuation: 1_000_000 });
    expect(withParity.parityPercent).toBe(25);
    expect(withParity.lot).toBe(computeMigrationRatio(base).lot);
  });
});

describe("computeMigrationRatio: refused inputs", () => {
  const ok = { oldTotalSupply: B(1_000_000), excludedAmount: ZERO, equityBps: 1000, decimals: 0 };
  it.each([
    ["zero supply", { oldTotalSupply: ZERO }],
    ["supply over u64::MAX", { oldTotalSupply: U64_MAX + ONE }],
    ["negative excluded", { excludedAmount: B(-1) }],
    ["excluded = supply", { excludedAmount: B(1_000_000) }],
    ["E = 0", { equityBps: 0 }],
    ["E over 100 %", { equityBps: 10_001 }],
    ["E not an integer", { equityBps: 12.5 }],
    ["G below 100", { granularity: B(99) }],
    ["G above 10^12", { granularity: pow10(12) + ONE }],
    ["G zero", { granularity: ZERO }],
    ["G negative", { granularity: B(-37_000) }],
    ["G not an integer", { granularity: 37_000.5 as unknown as bigint }],
    ["G a number, not a bigint", { granularity: 37_000 as unknown as bigint }],
    ["decimals 19", { decimals: 19 }],
    ["negative decimals", { decimals: -1 }],
  ])("%s", (_name, over) => {
    expect(() => computeMigrationRatio({ ...ok, ...over })).toThrow(RatioInputError);
  });
});

describe("per-holder helpers", () => {
  it("accepts exact multiples of at least one lot only", () => {
    expect(unitsForDeposit(B(15_000), B(5_000))).toBe(B(3));
    expect(unitsForDeposit(B(5_000), B(5_000))).toBe(ONE);
    expect(unitsForDeposit(B(4_999), B(5_000))).toBeNull();
    expect(unitsForDeposit(B(7_500), B(5_000))).toBeNull();
    expect(unitsForDeposit(ZERO, B(5_000))).toBeNull();
    expect(lotsFor(B(4_999), B(5_000))).toBe(ZERO);
    expect(lotsFor(B(-1), B(5_000))).toBe(ZERO);
    expect(() => depositAmountFor(ZERO, B(5_000))).toThrow(RatioInputError);
    expect(() => lotsFor(B(10), ZERO)).toThrow(RatioInputError);
    expect(() => unitsForDeposit(B(10), ZERO)).toThrow(RatioInputError);
  });
});

describe("display helpers", () => {
  it("formats base units exactly with grouping and trimmed fractions", () => {
    expect(formatBaseUnits(B("5000000000000"), 9)).toBe("5,000");
    expect(formatBaseUnits(B(1), 6)).toBe("0.000001");
    expect(formatBaseUnits(B(1_234_500_000), 6)).toBe("1,234.5");
    expect(formatBaseUnits(B(1_234_500_000), 6, 2)).toBe("1,234.50");
    expect(formatBaseUnits(U64_MAX, 0)).toBe("18,446,744,073,709,551,615");
    expect(formatBaseUnits(U64_MAX, 9)).toBe("18,446,744,073.709551615");
    expect(formatBaseUnits(ZERO, 9)).toBe("0");
    expect(formatUnits(B(120_000))).toBe("120,000");
  });

  it("parses typed token amounts into base units and refuses the rest", () => {
    expect(parseTokenAmount("1,234.5", 6)).toBe(B(1_234_500_000));
    expect(parseTokenAmount("0.000001", 6)).toBe(ONE);
    expect(parseTokenAmount("400000000", 0)).toBe(B(400_000_000));
    expect(parseTokenAmount("1.", 2)).toBe(B(100));
    for (const bad of ["", "-1", "1e5", "1.0000001", "abc", "1.2.3", " . "]) expect(parseTokenAmount(bad, 6), bad).toBeNull();
    expect(parseTokenAmount("18446744073709551616", 0)).toBeNull();
    expect(parseTokenAmount("1", 19)).toBeNull();
  });

  it("formats percentages and equity in basis points", () => {
    expect(formatPercentE4(B(120_000))).toBe("12.0000");
    expect(formatPercentE4(B(1))).toBe("0.0001");
    expect(formatPercentE4(B(1_000_000))).toBe("100.0000");
    expect(formatEquityBps(1200)).toBe("12");
    expect(formatEquityBps(1250)).toBe("12.5");
    expect(formatEquityBps(1)).toBe("0.01");
    expect(formatEquityBps(10_000)).toBe("100");
    expect(parseEquityPercent("12")).toBe(1200);
    expect(parseEquityPercent("12.5")).toBe(1250);
    expect(parseEquityPercent("0.01")).toBe(1);
    expect(parseEquityPercent("100")).toBe(10_000);
    for (const bad of ["0", "100.01", "12.345", "-1", "abc", ""]) expect(parseEquityPercent(bad), bad).toBeNull();
  });

  it("says what one unit is of the company: exact when 100 / G ends, marked ≈ when rounded", () => {
    expect(MIGRATION_GRANULARITIES.map((g) => unitPercent(g).text)).toEqual(["0.01", "0.001", "0.0001", "0.00001"]);
    expect(MIGRATION_GRANULARITIES.every((g) => unitPercent(g).exact)).toBe(true);
    expect(unitPercent(B(100))).toEqual({ text: "1", exact: true });
    expect(unitPercent(B(50_000))).toEqual({ text: "0.002", exact: true });
    expect(unitPercent(pow10(12))).toEqual({ text: "0.0000000001", exact: true });
    expect(unitPercent(B(37_000))).toEqual({ text: "0.0027", exact: false });
    expect(unitPercent(B(300))).toEqual({ text: "0.3333", exact: false });
    expect(unitPercent(B(7) * pow10(11))).toEqual({ text: "0.00000000014", exact: false });
    expect(percentClause(unitPercent(B(1_000_000)))).toBe("= 0.0001 %");
    expect(percentClause(unitPercent(B(37_000)))).toBe("≈ 0.0027 %");
    expect(() => unitPercent(ZERO)).toThrow(RatioInputError);
  });

  it("rounds a share half up to 4 decimals (more for a tiny one) and marks every rounded figure", () => {
    expect(percentFigure(B(120_000), B(1_000_000))).toEqual({ text: "12.0000", exact: true });
    expect(percentFigure(B(19), B(37_000))).toEqual({ text: "0.0514", exact: false }); // 0.051351… % rounds up
    expect(percentFigure(B(1), B(37_000))).toEqual({ text: "0.0027", exact: false }); // 0.0027027… % rounds down
    expect(percentFigure(B(1_234_567), B(10_000_000))).toEqual({ text: "12.3457", exact: false });
    expect(percentFigure(B(1), B(10_000_000))).toEqual({ text: "0.00001", exact: true });
    expect(percentFigure(B(2), B(1_000_000))).toEqual({ text: "0.0002", exact: true });
    expect(percentFigure(B(3), pow10(12))).toEqual({ text: "0.0000000003", exact: true });
    expect(percentFigure(ZERO, B(37_000))).toEqual({ text: "0.0000", exact: true });
    expect(percentFigure(B(37_000), B(37_000))).toEqual({ text: "100.0000", exact: true });
    expect(percentText({ text: "8.1081", exact: false })).toBe("≈ 8.1081");
    expect(percentText({ text: "12.0000", exact: true })).toBe("12.0000");
    expect(() => percentFigure(ONE, ZERO)).toThrow(RatioInputError);
    expect(() => percentFigure(B(-1), B(100))).toThrow(RatioInputError);
  });

  it("reads a typed G and refuses one outside 100..10^12 or not whole", () => {
    expect(parseGranularity("37000")).toBe(B(37_000));
    expect(parseGranularity(" 37,000 ")).toBe(B(37_000));
    expect(parseGranularity("37 000")).toBe(B(37_000));
    expect(parseGranularity("100")).toBe(MIN_GRANULARITY);
    expect(parseGranularity("1,000,000,000,000")).toBe(MAX_GRANULARITY);
    for (const bad of ["99", "1000000000001", "37000.5", "3.7e4", "-37000", "", "abc", "0"]) expect(parseGranularity(bad), bad).toBeNull();
    expect(isValidGranularity(MIN_GRANULARITY)).toBe(true);
    expect(isValidGranularity(MAX_GRANULARITY)).toBe(true);
    expect(isValidGranularity(B(99))).toBe(false);
    expect(isValidGranularity(MAX_GRANULARITY + ONE)).toBe(false);
    expect(isValidGranularity(37_000)).toBe(false);
    expect(MAX_GRANULARITY < B(Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});
