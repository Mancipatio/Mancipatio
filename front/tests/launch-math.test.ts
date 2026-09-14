// lib/launch-math.ts — pure deal math for the Equity Launch UI.
import { describe, expect, it } from "vitest";
import {
  daysLeft,
  impliedValuation,
  investorYieldShare,
  monthlyPayout,
  progressPct,
  yieldEstimate,
  yourEquity,
} from "@/lib/launch-math";

describe("impliedValuation", () => {
  it("raising $500k for 5% implies a $10M post-money", () => {
    expect(impliedValuation(500_000, 5)).toBe(10_000_000);
  });

  it("returns 0 for zero or negative equity offered", () => {
    expect(impliedValuation(500_000, 0)).toBe(0);
    expect(impliedValuation(500_000, -1)).toBe(0);
  });
});

describe("monthlyPayout", () => {
  it("$1.8M over 18mo with a 2mo cliff pays over 16 months", () => {
    expect(monthlyPayout(1_800_000, 18, 2)).toBe(112_500);
  });

  it("returns 0 when the cliff consumes the vesting horizon", () => {
    expect(monthlyPayout(1_000_000, 12, 12)).toBe(0);
    expect(monthlyPayout(1_000_000, 12, 13)).toBe(0);
  });

  it("rounds to whole dollars", () => {
    expect(monthlyPayout(1_000_000, 5, 2)).toBe(Math.round(1_000_000 / 3));
  });
});

describe("yieldEstimate", () => {
  it("5% APY on the average-unvested half over one year", () => {
    expect(yieldEstimate(1_000_000, 12)).toBe(25_000);
  });

  it("scales linearly with the vesting horizon", () => {
    expect(yieldEstimate(1_000_000, 24)).toBe(50_000);
    expect(yieldEstimate(1_000_000, 6)).toBe(12_500);
  });
});

describe("yourEquity", () => {
  it("a $1k ticket in a $1.5M raise for 12.5% equity", () => {
    expect(yourEquity(12.5, 1000, 1_500_000)).toBeCloseTo(0.008333, 5);
  });

  it("committing the full raise earns the full offered equity", () => {
    expect(yourEquity(10, 500_000, 500_000)).toBe(10);
  });

  it("returns 0 for a non-positive raise", () => {
    expect(yourEquity(10, 1000, 0)).toBe(0);
  });
});

describe("investorYieldShare", () => {
  it("is 1/3 of total yield, pro-rata to the ticket", () => {
    // Total yield on $1.2M over 12mo = 30_000; half the raise → 1/3 * 1/2.
    expect(investorYieldShare(1_200_000, 12, 600_000)).toBe(5_000);
  });

  it("returns 0 when the raise is 0", () => {
    expect(investorYieldShare(0, 12, 1000)).toBe(0);
  });
});

describe("progressPct", () => {
  it("rounds and clamps to 0–100", () => {
    expect(progressPct(892_000, 1_500_000)).toBe(59);
    expect(progressPct(2_000_000, 1_500_000)).toBe(100); // clamp
    expect(progressPct(0, 1_500_000)).toBe(0);
    expect(progressPct(100, 0)).toBe(0); // guard on target
  });
});

describe("daysLeft", () => {
  it("returns 0 for the unset sentinel (endTs === 0)", () => {
    expect(daysLeft(BigInt(0), 1_000)).toBe(0);
  });

  it("returns 0 when the end is in the past", () => {
    expect(daysLeft(BigInt(999), 1_000)).toBe(0);
  });

  it("ceils partial days upward", () => {
    expect(daysLeft(BigInt(1_000 + 1), 1_000)).toBe(1); // 1s left → 1 day
    expect(daysLeft(BigInt(1_000 + 86_400), 1_000)).toBe(1); // exactly 1 day
    expect(daysLeft(BigInt(1_000 + 86_401), 1_000)).toBe(2);
  });
});
