// Employee equity (ESOP) preset for issuer vesting series
// (/issuer/vesting-series, app/issuer/vesting-series/series-form.tsx): a
// cliff, then monthly tranches until the allocation is fully vested, as EXACT
// base-unit amounts that the series form puts into the create_vesting_series
// terms (the issuer reviews and can edit everything before signing).
//
// Amounts. The cumulative vested at month m is floor(total × m / totalMonths),
// for every unlock month from the cliff to the end; a tranche is the
// difference from the previous unlock. So the cliff tranche is
// floor(total × cliff / months) (25 % for 12 of 48), the monthly tranches are
// as equal as integers allow (they differ by at most one base unit), and the
// last tranche makes the cumulative exactly equal to the allocation: the
// schedule total always equals the sum of the allocations, which
// lib/vesting-terms assertSupportedVestingTerms and the program require. A
// month whose difference is 0 (a total smaller than the number of months, e.g.
// 7 units over 37 unlocks) carries no tranche: the program refuses a tranche
// of 0, and those units vest at the next unlock that has any. Share-class
// mints have 0 decimals, so small totals are the normal case, not an edge.
//
// Dates. Month arithmetic in UTC, always counted from the start (never month
// after month, which would drift), with the day clamped to the length of the
// target month: a start on 31 January unlocks on 28 February (29 in a leap
// year), then on 31 March. The time of day is kept. Unlock times therefore
// strictly ascend.
//
// What the preset does NOT decide: the program's vesting is per series, not
// per person. Approval timing only delays delivery (a vested tranche is
// delivered once approved or when the window lapses, and cancellation keeps
// everything vested, approved or not), and cancelling stops future vesting
// for EVERY recipient of the series. Per-person leaver terms therefore need
// one series per grant; the public guide (/solutions/esop) says so.
//
// Pure and node-safe: tests/esop-schedule.test.ts.

import { MAX_WALLET_VESTING_TRANCHES, U64_MAX } from "@/lib/vesting-terms";

/** The preset as the series form applies it; every value stays editable before signing. */
export const ESOP_PRESET = {
  label: "Employee equity (ESOP): 12-month cliff, 48 months total, monthly",
  cliffMonths: 12,
  totalMonths: 48,
  /** Approval timing: each monthly tranche waits for the issuer's approval… */
  timingMode: "approval" as const,
  /**
   * …for at most 14 days, then it is delivered anyway (approval delays,
   * never freezes). Two weeks covers a monthly payroll check and keeps a
   * recipient's delay short; the form allows 1 hour to 90 days.
   */
  approvalWindowSecs: 14 * 86_400,
  /** Cancellation on, with nothing kept if it happens before the cliff. */
  cancellationEnabled: true,
  preCliffBps: 0,
  /** Recovery on: a lost recipient wallet can be re-pointed to a replacement. */
  recoveryEnabled: true,
};

export type EsopScheduleInput = {
  /** Sum of every recipient's allocation, in base units (1 … u64::MAX). */
  total: bigint;
  /** Vesting start (the grant date), unix seconds UTC. */
  startTs: number;
  /** Months before the first unlock; 0 = an unlock every month from month 1. Default 12. */
  cliffMonths?: number;
  /** Months until the allocation is fully vested. Default 48. */
  totalMonths?: number;
  /** Most unlock months the schedule may have. Default: the wallet flow's limit (48). */
  maxTranches?: number;
};

export type EsopTranche = {
  /** Months after the start (cliff … totalMonths). */
  month: number;
  /** Unix seconds UTC. */
  unlockTs: number;
  /** Base units unlocked at this time (> 0). */
  amount: bigint;
};

const SECONDS_PER_DAY = 86_400;

function daysInUtcMonth(year: number, monthIndex: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * `ts` plus `months` calendar months, in UTC, with the day clamped to the
 * target month's length (31 Jan + 1 → 28/29 Feb). Unix seconds in and out.
 */
export function addUtcMonths(ts: number, months: number): number {
  if (!Number.isSafeInteger(ts) || ts < 0) throw new RangeError("The start must be unix seconds (a non-negative integer).");
  if (!Number.isSafeInteger(months) || months < 0) throw new RangeError("Months must be a non-negative integer.");
  const start = new Date(ts * 1000);
  const index = start.getUTCMonth() + months;
  const year = start.getUTCFullYear() + Math.floor(index / 12);
  const month = index % 12;
  const day = Math.min(start.getUTCDate(), daysInUtcMonth(year, month));
  return (
    Date.UTC(year, month, day, start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds()) / 1000
  );
}

/** The unlock months of a cliff/total shape: cliff … total (1 … total without a cliff). */
export function esopUnlockMonths(cliffMonths: number, totalMonths: number): number[] {
  const first = Math.max(cliffMonths, 1);
  return Array.from({ length: totalMonths - first + 1 }, (_, i) => first + i);
}

/**
 * The cliff-then-monthly schedule of `total` base units. Throws a RangeError
 * naming the rule for an input the series form must not submit.
 */
export function esopSchedule(input: EsopScheduleInput): EsopTranche[] {
  const cliffMonths = input.cliffMonths ?? ESOP_PRESET.cliffMonths;
  const totalMonths = input.totalMonths ?? ESOP_PRESET.totalMonths;
  const maxTranches = input.maxTranches ?? MAX_WALLET_VESTING_TRANCHES;
  if (typeof input.total !== "bigint" || input.total <= BigInt(0)) throw new RangeError("The total allocation must be more than 0.");
  if (input.total > U64_MAX) throw new RangeError("The total allocation exceeds the token program limit.");
  if (!Number.isSafeInteger(totalMonths) || totalMonths < 1) throw new RangeError("The vesting period must be at least one month.");
  if (!Number.isSafeInteger(cliffMonths) || cliffMonths < 0 || cliffMonths > totalMonths) {
    throw new RangeError("The cliff must be between 0 months and the vesting period.");
  }
  const months = esopUnlockMonths(cliffMonths, totalMonths);
  if (months.length > maxTranches) {
    throw new RangeError(`This schedule needs ${months.length} monthly unlocks; a series supports at most ${maxTranches}.`);
  }
  const total = input.total;
  const period = BigInt(totalMonths);
  const out: EsopTranche[] = [];
  let vested = BigInt(0);
  for (const month of months) {
    // The last month is exact: total × period / period.
    const cumulative = (total * BigInt(month)) / period;
    const amount = cumulative - vested;
    if (amount > BigInt(0)) {
      out.push({ month, unlockTs: addUtcMonths(input.startTs, month), amount });
      vested = cumulative;
    }
  }
  return out;
}

/** "YYYY-MM-DD" → unix seconds at 00:00 UTC that day; null for anything else, a non-existent date included. */
export function parseUtcDate(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > daysInUtcMonth(year, month - 1)) return null;
  return Date.UTC(year, month - 1, day) / 1000;
}

/** Unix seconds → "YYYY-MM-DD" of that UTC day (the value of a date input). */
export function utcDateString(ts: number): string {
  return new Date(Math.floor(ts / SECONDS_PER_DAY) * SECONDS_PER_DAY * 1000).toISOString().slice(0, 10);
}

/**
 * The preset's tranches as the form's manual rows (percent of the total),
 * for "Edit tranches manually": percentages rounded to 4 decimals, with the
 * last row taking the remainder so the rows add up to exactly 100 (the
 * form's own check). The form then computes amounts from percentages as it
 * always does, and its review step shows the exact amounts again.
 */
export function esopPercentRows(tranches: readonly EsopTranche[], total: bigint): { unlockTs: number; pct: string }[] {
  if (tranches.length === 0 || total <= BigInt(0)) return [];
  // Shares in 1/10,000 of a percent, as integers: 100 % = 1,000,000.
  const whole = BigInt(1_000_000);
  let assigned = BigInt(0);
  return tranches.map((t, i) => {
    const share = i === tranches.length - 1 ? whole - assigned : (t.amount * whole) / total;
    assigned += share;
    return { unlockTs: t.unlockTs, pct: formatPercentE4(share) };
  });
}

/**
 * A total that divides evenly into the default 48 months, for showing the
 * preset's shape (and converting it to manual rows) before any recipient
 * allocation is entered.
 */
export const ESOP_NOMINAL_TOTAL = BigInt(48_000_000);

/** 1/10,000 of a percent → "12.3456" (trailing zeros trimmed). */
function formatPercentE4(e4: bigint): string {
  const whole = e4 / BigInt(10_000);
  const frac = (e4 % BigInt(10_000)).toString().padStart(4, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** A tranche's share of the total, in percent with up to 4 decimals (display). */
export function esopSharePercent(amount: bigint, total: bigint): string {
  if (total <= BigInt(0)) return "0";
  return formatPercentE4((amount * BigInt(1_000_000)) / total);
}
