// lib/esop-schedule.ts — the ESOP preset of the issuer vesting-series form:
// exact sums for awkward totals (the last tranche makes the cumulative equal
// the allocation, no tranche of 0), UTC month arithmetic across month ends
// and leap years, the cliff-0 shape, the tranche limit, and terms the
// series' own validation (lib/vesting-terms) accepts.
import { describe, expect, it } from "vitest";
import {
  addUtcMonths,
  ESOP_NOMINAL_TOTAL,
  ESOP_PRESET,
  esopPercentRows,
  esopSchedule,
  esopSharePercent,
  esopUnlockMonths,
  parseUtcDate,
  utcDateString,
  type EsopTranche,
} from "@/lib/esop-schedule";
import { assertSupportedVestingTerms, MAX_WALLET_VESTING_TRANCHES, U64_MAX } from "@/lib/vesting-terms";

const utc = (iso: string) => Date.parse(iso) / 1000;
const iso = (ts: number) => new Date(ts * 1000).toISOString();
const sum = (tranches: readonly EsopTranche[]) => tranches.reduce((n, t) => n + t.amount, BigInt(0));
const START = utc("2027-01-15T00:00:00Z");

describe("esopSchedule amounts", () => {
  it("the default shape: a 25 % cliff at month 12, then 36 monthly tranches, 37 in all", () => {
    const tranches = esopSchedule({ total: BigInt(48_000), startTs: START });
    expect(tranches).toHaveLength(37);
    expect(tranches[0]).toMatchObject({ month: 12, amount: BigInt(12_000) });
    expect(tranches.slice(1).every((t) => t.amount === BigInt(1_000))).toBe(true);
    expect(tranches.map((t) => t.month)).toEqual(esopUnlockMonths(12, 48));
    expect(sum(tranches)).toBe(BigInt(48_000));
  });

  it.each([
    [BigInt(1)],
    [BigInt(7)],
    [BigInt(37)],
    [BigInt(47)],
    [BigInt(48)],
    [BigInt(49)],
    [BigInt(500)],
    [BigInt(10_000)],
    [BigInt(999_999_937)],
    [BigInt(10) ** BigInt(12)],
    [U64_MAX],
  ])("total %s: exact sum, every tranche positive, ascending, the cumulative never ahead of linear", (total) => {
    const tranches = esopSchedule({ total, startTs: START });
    expect(sum(tranches)).toBe(total);
    let previous = 0;
    let cumulative = BigInt(0);
    for (const t of tranches) {
      expect(t.amount > BigInt(0)).toBe(true);
      expect(t.unlockTs).toBeGreaterThan(previous);
      previous = t.unlockTs;
      cumulative += t.amount;
      // floor(total × m / 48): within one base unit below the linear figure, never above it.
      const linear = (total * BigInt(t.month)) / BigInt(48);
      expect(cumulative).toBe(linear);
    }
    // The last unlock is always month 48, where everything has vested.
    expect(tranches.at(-1)?.month).toBe(48);
  });

  it("small totals skip the months that would carry 0 (the program refuses a 0 tranche)", () => {
    expect(esopSchedule({ total: BigInt(1), startTs: START })).toEqual([
      { month: 48, unlockTs: addUtcMonths(START, 48), amount: BigInt(1) },
    ]);
    const seven = esopSchedule({ total: BigInt(7), startTs: START });
    expect(seven.map((t) => [t.month, Number(t.amount)])).toEqual([[12, 1], [14, 1], [21, 1], [28, 1], [35, 1], [42, 1], [48, 1]]);
    const thirtySeven = esopSchedule({ total: BigInt(37), startTs: START });
    expect(thirtySeven[0]).toMatchObject({ month: 12, amount: BigInt(9) });
    expect(thirtySeven.every((t) => t.amount === BigInt(1) || t.month === 12)).toBe(true);
    expect(thirtySeven).toHaveLength(1 + 28);
  });

  it("monthly tranches of a large total differ by at most one base unit, the cliff is floor(total / 4)", () => {
    const total = BigInt(10) ** BigInt(12) + BigInt(7);
    const tranches = esopSchedule({ total, startTs: START });
    expect(tranches[0].amount).toBe(total / BigInt(4));
    const monthly = tranches.slice(1).map((t) => t.amount);
    const min = monthly.reduce((a, b) => (b < a ? b : a));
    const max = monthly.reduce((a, b) => (b > a ? b : a));
    expect(max - min <= BigInt(1)).toBe(true);
    expect(sum(tranches)).toBe(total);
  });

  it("cliff 0: an unlock every month from month 1, 48 in all (the wallet flow's limit)", () => {
    const tranches = esopSchedule({ total: BigInt(4_800), startTs: START, cliffMonths: 0 });
    expect(tranches).toHaveLength(48);
    expect(tranches[0]).toMatchObject({ month: 1, amount: BigInt(100), unlockTs: utc("2027-02-15T00:00:00Z") });
    expect(sum(tranches)).toBe(BigInt(4_800));
    expect(MAX_WALLET_VESTING_TRANCHES).toBe(48);
  });

  it("a cliff equal to the period vests everything at once", () => {
    expect(esopSchedule({ total: BigInt(10), startTs: START, cliffMonths: 24, totalMonths: 24 })).toEqual([
      { month: 24, unlockTs: utc("2029-01-15T00:00:00Z"), amount: BigInt(10) },
    ]);
  });

  it("refuses what the series cannot hold", () => {
    expect(() => esopSchedule({ total: BigInt(0), startTs: START })).toThrow(/more than 0/);
    expect(() => esopSchedule({ total: U64_MAX + BigInt(1), startTs: START })).toThrow(/token program limit/);
    expect(() => esopSchedule({ total: BigInt(10), startTs: START, cliffMonths: 0, totalMonths: 60 })).toThrow(/60 monthly unlocks; a series supports at most 48/);
    expect(() => esopSchedule({ total: BigInt(10), startTs: START, cliffMonths: 49 })).toThrow(/cliff/);
    expect(() => esopSchedule({ total: BigInt(10), startTs: START, totalMonths: 0 })).toThrow(/at least one month/);
    expect(() => esopSchedule({ total: BigInt(10), startTs: -1 })).toThrow(/unix seconds/);
    expect(() => esopSchedule({ total: BigInt(10), startTs: START, cliffMonths: 1.5 })).toThrow(/cliff/);
  });
});

describe("UTC month arithmetic", () => {
  it("clamps the day to the target month and always counts from the start (no drift)", () => {
    const jan31 = utc("2027-01-31T09:30:15Z");
    expect(iso(addUtcMonths(jan31, 1))).toBe("2027-02-28T09:30:15.000Z");
    expect(iso(addUtcMonths(jan31, 2))).toBe("2027-03-31T09:30:15.000Z");
    expect(iso(addUtcMonths(jan31, 3))).toBe("2027-04-30T09:30:15.000Z");
    expect(iso(addUtcMonths(jan31, 13))).toBe("2028-02-29T09:30:15.000Z"); // 2028 is a leap year
    expect(iso(addUtcMonths(jan31, 12))).toBe("2028-01-31T09:30:15.000Z");
    expect(iso(addUtcMonths(jan31, 0))).toBe("2027-01-31T09:30:15.000Z");
  });

  it("a 29 February start lands on 28 February in common years and 29 February in leap years", () => {
    const leap = utc("2028-02-29T00:00:00Z");
    expect(iso(addUtcMonths(leap, 12))).toBe("2029-02-28T00:00:00.000Z");
    expect(iso(addUtcMonths(leap, 48))).toBe("2032-02-29T00:00:00.000Z");
    expect(iso(addUtcMonths(leap, 1))).toBe("2028-03-29T00:00:00.000Z");
  });

  it("crosses year ends and century leap rules (2100 is not a leap year)", () => {
    expect(iso(addUtcMonths(utc("2027-11-30T00:00:00Z"), 3))).toBe("2028-02-29T00:00:00.000Z");
    expect(iso(addUtcMonths(utc("2099-12-31T00:00:00Z"), 2))).toBe("2100-02-28T00:00:00.000Z");
    expect(iso(addUtcMonths(utc("2027-12-15T00:00:00Z"), 1))).toBe("2028-01-15T00:00:00.000Z");
  });

  it("the preset from a 31 January start: cliff on 31 January a year later, then month ends", () => {
    const tranches = esopSchedule({ total: BigInt(48), startTs: utc("2027-01-31T00:00:00Z") });
    expect(iso(tranches[0].unlockTs)).toBe("2028-01-31T00:00:00.000Z");
    expect(iso(tranches[1].unlockTs)).toBe("2028-02-29T00:00:00.000Z");
    expect(iso(tranches[2].unlockTs)).toBe("2028-03-31T00:00:00.000Z");
    expect(iso(tranches.at(-1)!.unlockTs)).toBe("2031-01-31T00:00:00.000Z");
  });

  it("is independent of the machine's time zone (UTC fields only)", () => {
    // Midnight UTC stays midnight UTC: no local-time conversion slips a day.
    const ts = addUtcMonths(utc("2027-03-31T00:00:00Z"), 1);
    expect(iso(ts)).toBe("2027-04-30T00:00:00.000Z");
  });
});

describe("date input helpers", () => {
  it("parses a real UTC date and refuses impossible ones", () => {
    expect(parseUtcDate("2027-01-31")).toBe(utc("2027-01-31T00:00:00Z"));
    expect(parseUtcDate(" 2028-02-29 ")).toBe(utc("2028-02-29T00:00:00Z"));
    for (const bad of ["2027-02-29", "2027-13-01", "2027-00-10", "2027-04-31", "1969-12-31", "27-01-01", "", "2027/01/01"]) {
      expect(parseUtcDate(bad), bad).toBeNull();
    }
  });
  it("formats the UTC day of a timestamp", () => {
    expect(utcDateString(utc("2027-01-31T23:59:59Z"))).toBe("2027-01-31");
    expect(utcDateString(utc("2027-02-01T00:00:00Z"))).toBe("2027-02-01");
  });
});

describe("manual rows and shares", () => {
  it("converts to percent rows that add up to exactly 100, the last taking the remainder", () => {
    const tranches = esopSchedule({ total: ESOP_NOMINAL_TOTAL, startTs: START });
    const rows = esopPercentRows(tranches, ESOP_NOMINAL_TOTAL);
    expect(rows).toHaveLength(37);
    expect(rows[0].pct).toBe("25");
    expect(rows[1].pct).toBe("2.0833");
    expect(rows.at(-1)!.pct).toBe("2.0845");
    const e4 = rows.reduce((n, r) => n + Math.round(Number(r.pct) * 10_000), 0);
    expect(e4).toBe(1_000_000);
    expect(rows.map((r) => r.unlockTs)).toEqual(tranches.map((t) => t.unlockTs));
  });
  it("shares for display", () => {
    expect(esopSharePercent(BigInt(1), BigInt(3))).toBe("33.3333");
    expect(esopSharePercent(BigInt(12), BigInt(48))).toBe("25");
    expect(esopSharePercent(BigInt(1), BigInt(0))).toBe("0");
  });
});

describe("the preset produces terms the series accepts", () => {
  it("passes lib/vesting-terms assertSupportedVestingTerms for awkward totals split over recipients", () => {
    const now = utc("2026-11-08T12:00:00Z");
    const startTs = parseUtcDate("2026-11-09")!;
    const wallet = (n: number) => ["11111111111111111111111111111112", "So11111111111111111111111111111111111111112", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"][n];
    for (const allocations of [[BigInt(1)], [BigInt(3), BigInt(4)], [BigInt(10), BigInt(20), BigInt(7)], [BigInt(10) ** BigInt(12)]]) {
      const total = allocations.reduce((a, b) => a + b, BigInt(0));
      const schedule = esopSchedule({ total, startTs }).map((t) => ({ unlock_ts: t.unlockTs, amount: t.amount.toString() }));
      expect(() => assertSupportedVestingTerms({
        network: "devnet",
        client_wallet: wallet(0),
        token_mint: wallet(2),
        token_label: "ESOP 2026",
        timing_mode: ESOP_PRESET.timingMode,
        delivery_mode: "claim",
        approval_window_secs: ESOP_PRESET.approvalWindowSecs,
        recovery_enabled: ESOP_PRESET.recoveryEnabled,
        cancellation_enabled: ESOP_PRESET.cancellationEnabled,
        pre_cliff_bps: ESOP_PRESET.preCliffBps,
        schedule,
        recipients: allocations.map((a, i) => ({ wallet: wallet(i), allocation: a.toString() })),
      }, now), allocations.join("+")).not.toThrow();
    }
  });

  it("the preset values are the ones the brief asks for", () => {
    expect(ESOP_PRESET).toMatchObject({
      cliffMonths: 12, totalMonths: 48, timingMode: "approval", cancellationEnabled: true, preCliffBps: 0, recoveryEnabled: true,
    });
    // Within the form's 1 hour … 90 days.
    expect(ESOP_PRESET.approvalWindowSecs).toBeGreaterThanOrEqual(3_600);
    expect(ESOP_PRESET.approvalWindowSecs).toBeLessThanOrEqual(7_776_000);
  });
});
