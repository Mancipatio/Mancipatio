// The ESOP preset in the issuer vesting-series form
// (app/issuer/vesting-series/series-form.tsx): offered on a new form, wired
// to set every value it promises, and submitting the generator's exact
// amounts (never the basis-point percent rows) while it is on. No jsdom here:
// the first render is static markup, the click wiring is pinned by source
// (the repo's way of testing page wiring, see tests/onboarding-page.test.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@solana/react-hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@solana/react-hooks")>()),
  useSolanaClient: () => ({ runtime: { rpc: {} } }),
}));

import { scheduleFromPercents, scheduleFromRows, SeriesForm } from "@/app/issuer/vesting-series/series-form";
import { ESOP_PRESET, esopPercentRows, esopSchedule } from "@/lib/esop-schedule";

const source = readFileSync(join(process.cwd(), "app/issuer/vesting-series/series-form.tsx"), "utf8");

describe("ESOP preset in the vesting-series form", () => {
  it("is offered on a new series form, next to the manual percent rows", () => {
    const html = renderToStaticMarkup(createElement(SeriesForm, {
      submitting: false, onSubmit: async () => {}, onClose: () => {}, title: "New vesting series",
    }));
    expect(html).toContain("Employee equity (ESOP): 12-month cliff, 48 months total, monthly");
    expect(html).toContain(ESOP_PRESET.label);
    // The manual rows are what a new form starts with; the preset is a choice.
    expect(html).toContain("Total: 100.00% (must equal 100%)");
    expect(html).not.toContain("Vesting start (00:00 UTC)");
  });

  it("sets approval timing, the window, cancellation with pre-cliff 0 and recovery, all through the ordinary controls", () => {
    const apply = source.slice(source.indexOf("function applyEsopPreset()"), source.indexOf("function editEsopManually()"));
    for (const line of [
      "setEsopStart(utcDateString(currentUnixSeconds()));",
      "setTimingMode(ESOP_PRESET.timingMode);",
      "setWindowDays(String(ESOP_PRESET.approvalWindowSecs / 86_400));",
      "setCancellation(ESOP_PRESET.cancellationEnabled);",
      "setPreCliffPct(String(ESOP_PRESET.preCliffBps / 100));",
      "setRecovery(ESOP_PRESET.recoveryEnabled);",
    ]) expect(apply, line).toContain(line);
  });

  it("submits the generator's exact amounts while on, and validates its schedule instead of the percent rows", () => {
    expect(source).toContain("esopSchedule({ total, startTs })");
    expect(source).toMatch(/esop\?\.ok && !esop\.nominal\s*\? esop\.tranches\.map\(\(t\) => \(\{ unlock_ts: t\.unlockTs, amount: t\.amount\.toString\(\) \}\)\)\s*: scheduleFromRows\(rows, totalAllocated\)/);
    const validate = source.slice(source.indexOf("function validate()"), source.indexOf("function buildPayload()"));
    expect(validate.indexOf("if (esop) {")).toBeGreaterThan(-1);
    expect(validate.indexOf("if (esop) {")).toBeLessThan(validate.indexOf("Tranche percentages must add up to 100"));
    // Manual rows: a tranche of 0 (which the program refuses) is caught before anything is signed.
    expect(validate).toContain("would unlock 0 base units");
  });

  it("stays editable: manual rows from the preset keep the exact amounts while only dates change", () => {
    expect(source).toContain("esopPercentRows(esop.tranches, esop.total)");
    expect(source).toContain("...(esop.nominal ? {} : { units: esop.tranches[i].amount.toString() })");
    expect(source).toContain("Edit tranches manually");
    expect(source).toContain("onRemove={() => setEsopStart(null)}");
    // A percentage edit, or adding or removing a row, drops the exact amounts.
    expect(source).toContain("j === i ? { ...x, pct: e.target.value, units: undefined } : { ...x, units: undefined }");
    expect(source).toContain("ts.filter((_, j) => j !== i).map((x) => ({ ...x, units: undefined }))");
    expect(source).toContain("[...ts.map((x) => ({ ...x, units: undefined })), { at: \"\", pct: \"\" }]");
    // The per-series limits are said where the preset is applied.
    expect(source).toContain("create one series per grant");
  });
});

describe("manual rows: exact preset amounts, and percentages to 1/10,000 of a percent", () => {
  const rows = (pcts: string[], units?: string[]) =>
    pcts.map((pct, i) => ({ unlockTs: 1_800_000_000 + i * 60, pct, ...(units ? { units: units[i] } : {}) }));

  it("uses the carried amounts when they add up to the total (small totals stay whole)", () => {
    const total = BigInt(48);
    const tranches = esopSchedule({ total, startTs: 1_790_000_000 });
    const converted = esopPercentRows(tranches, total).map((r, i) => ({ ...r, units: tranches[i].amount.toString() }));
    const schedule = scheduleFromRows(converted, total);
    expect(schedule.map((t) => t.amount)).toEqual(tranches.map((t) => t.amount.toString()));
    expect(schedule.every((t) => BigInt(t.amount) > BigInt(0))).toBe(true);
    // The same rows as plain percentages would floor most tranches to 0: why the units travel.
    const fromPercents = scheduleFromPercents(converted, total);
    expect(fromPercents.some((t) => t.amount === "0")).toBe(true);
  });

  it("falls back to the percentages when a row has no amount or the total changed", () => {
    const pcts = ["50", "50"];
    expect(scheduleFromRows(rows(pcts, ["30", "70"]), BigInt(100)).map((t) => t.amount)).toEqual(["30", "70"]);
    expect(scheduleFromRows(rows(pcts, ["30", "70"]), BigInt(200)).map((t) => t.amount)).toEqual(["100", "100"]);
    expect(scheduleFromRows(rows(pcts), BigInt(100)).map((t) => t.amount)).toEqual(["50", "50"]);
  });

  it("two-decimal percentages give the same amounts as basis points did; four decimals no longer drift", () => {
    expect(scheduleFromPercents(rows(["33.33", "33.33", "33.34"]), BigInt(1_000_000)).map((t) => t.amount)).toEqual(["333300", "333300", "333400"]);
    expect(scheduleFromPercents(rows(["12.5", "87.5"]), BigInt(7)).map((t) => t.amount)).toEqual(["0", "7"]);
    const esop = scheduleFromPercents(rows(["25", "2.0833", "72.9167"]), BigInt(48_000_000));
    expect(esop.map((t) => t.amount)).toEqual(["12000000", "999984", "35000016"]);
  });
});
