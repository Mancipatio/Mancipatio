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

import { SeriesForm } from "@/app/issuer/vesting-series/series-form";
import { ESOP_PRESET } from "@/lib/esop-schedule";

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
    expect(source).toMatch(/esop\?\.ok && !esop\.nominal\s*\? esop\.tranches\.map\(\(t\) => \(\{ unlock_ts: t\.unlockTs, amount: t\.amount\.toString\(\) \}\)\)\s*: scheduleFromPercents\(rows, totalAllocated\)/);
    const validate = source.slice(source.indexOf("function validate()"), source.indexOf("function buildPayload()"));
    expect(validate.indexOf("if (esop) {")).toBeGreaterThan(-1);
    expect(validate.indexOf("if (esop) {")).toBeLessThan(validate.indexOf("Tranche percentages must add up to 100"));
  });

  it("stays editable: manual rows from the preset, or the preset removed", () => {
    expect(source).toContain("esopPercentRows(esop.tranches, esop.total)");
    expect(source).toContain("Edit tranches manually");
    expect(source).toContain("onRemove={() => setEsopStart(null)}");
    // The per-series limits are said where the preset is applied.
    expect(source).toContain("create one series per grant");
  });
});
