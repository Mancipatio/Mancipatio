// Pure deal math for the Equity Launch UI. No I/O, no React — easy to verify.
// All money values are whole-dollar numbers (not base units) at the UI layer.

/** Implied post-money valuation: raising $X for Y% equity ⇒ X / (Y/100). */
export function impliedValuation(raiseAmount: number, equityOffered: number): number {
  if (equityOffered <= 0) return 0;
  return raiseAmount / (equityOffered / 100);
}

/** Monthly tranche for a vested startup raise, paid over (vesting − cliff) months. */
export function monthlyPayout(raiseAmount: number, vestingMonths: number, cliffMonths: number): number {
  const effective = vestingMonths - cliffMonths;
  if (effective <= 0) return 0;
  return Math.round(raiseAmount / effective);
}

/** Rough 5% APY yield on the average-unvested balance over the vesting horizon. */
export function yieldEstimate(raiseAmount: number, vestingMonths: number): number {
  const avgUnvested = raiseAmount * 0.5;
  return Math.round(avgUnvested * 0.05 * (vestingMonths / 12));
}

/** An investor's equity %: their ticket as a fraction of the raise, times equity offered. */
export function yourEquity(equityOffered: number, commit: number, raiseAmount: number): number {
  if (raiseAmount <= 0) return 0;
  return equityOffered * (commit / raiseAmount);
}

/** An investor's 1/3 share of the total yield, pro-rata to their ticket. */
export function investorYieldShare(raiseAmount: number, vestingMonths: number, commit: number): number {
  const totalYield = yieldEstimate(raiseAmount, vestingMonths);
  const fraction = raiseAmount > 0 ? commit / raiseAmount : 0;
  return Math.round(totalYield * (1 / 3) * fraction);
}

/** Progress percentage 0–100, clamped. */
export function progressPct(raised: number, target: number): number {
  if (target <= 0) return 0;
  return Math.min(100, Math.round((raised / target) * 100));
}

/** Whole days until an end timestamp (unix seconds). 0 if past or unset (endTs===0). */
export function daysLeft(endTsSeconds: bigint, nowSeconds: number): number {
  if (endTsSeconds === BigInt(0)) return 0;
  const diff = Number(endTsSeconds) - nowSeconds;
  if (diff <= 0) return 0;
  return Math.ceil(diff / 86400);
}

/**
 * Worked examples (verify by reading + the node check in the task):
 *   impliedValuation(500000, 5)            === 10_000_000   ($0.5M for 5% ⇒ $10M)
 *   monthlyPayout(1_800_000, 18, 2)        === 112_500      ($1.8M over 16 mo)
 *   yieldEstimate(1_000_000, 12)           === 25_000       (0.5M * 5% * 1yr)
 *   yourEquity(12.5, 1000, 1_500_000)      ≈ 0.008333       (%)
 *   progressPct(892_000, 1_500_000)        === 59
 *   daysLeft(0n, 1_000)                    === 0
 */
