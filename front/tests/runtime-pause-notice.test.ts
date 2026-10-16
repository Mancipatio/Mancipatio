import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAUSE_CUSTODY_ENTRY, PAUSE_PRIMARY, PAUSE_SECONDARY, PLATFORM_BOOTSTRAP_OPEN } from "@/lib/pause-flags";
import { combinedRuntimePauseNotice, runtimePauseFlow, runtimePauseFlows, runtimePauseNotice } from "@/lib/runtime-pause-notice";

const state = vi.hoisted(() => ({ flags: null as number | null, reads: vi.fn() }));
vi.mock("@/lib/use-pause-flags", () => ({ usePauseFlags: () => { state.reads(); return state.flags; } }));
import { RuntimePauseNotice } from "@/components/runtime-pause-notice";

beforeEach(() => vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet"));
afterEach(() => vi.unstubAllEnvs());

describe("runtime pause notices", () => {
  it.each([
    ["/marketplace/launchpad", "primary"], ["/marketplace/launchpad/sale-1", "primary"],
    ["/issuer/launchpad/", "primary"], ["/marketplace/otc/offer-1", "secondary"],
    ["/markets/resell?type=equity", "secondary"], ["/portfolio/offers", "secondary"],
    ["/portfolio/deals", "secondary"], ["/portfolio/listings#mine", "secondary"],
    ["/portfolio/conversion", "conversion"],
  ])("maps %s to the %s pause", (path, flow) => {
    expect(runtimePauseFlow(path)).toBe(flow);
  });

  it.each(["/marketplace", "/issuer", "/verify", "/portfolio", "/admin/platform", "/marketplace/launchpad-extra", "/portfolio/conversion-guide"])("does not assign a trading pause to %s", (path) => {
    expect(runtimePauseFlow(path)).toBeNull();
  });

  it("uses only the pause bit of the selected flow", () => {
    expect(runtimePauseNotice("primary", PAUSE_PRIMARY)?.title).toBe("Primary sales are paused");
    expect(runtimePauseNotice("secondary", PAUSE_SECONDARY)?.title).toBe("Trading through Manci is paused");
    expect(runtimePauseNotice("conversion", PAUSE_CUSTODY_ENTRY)?.title).toBe("Conversion escrow entry is paused");
    expect(runtimePauseNotice("primary", PAUSE_SECONDARY)).toBeNull();
    expect(runtimePauseNotice("secondary", PAUSE_PRIMARY)).toBeNull();
    expect(runtimePauseNotice("conversion", PLATFORM_BOOTSTRAP_OPEN)).toBeNull();
  });

  it("shows each selected flow paused for flags 126 while preserving existing exits", () => {
    for (const flow of ["primary", "secondary", "conversion"] as const) {
      const notice = runtimePauseNotice(flow, 126);
      expect(notice?.tone).toBe("paused");
      expect(notice?.exits).toMatch(/Existing/);
      expect(notice?.exits).toMatch(/refunds|returns/);
    }
  });

  it.each([null, -1, 256, Number.NaN, 2.5])("never treats unknown or invalid flags %s as active", (flags) => {
    const notice = runtimePauseNotice("primary", flags);
    expect(notice?.tone).toBe("unknown");
    expect(notice?.title).toBe("Checking transaction availability");
    expect(JSON.stringify(notice)).not.toMatch(/Active|Trading is available/);
  });

  it("does not announce activation merely because a pause bit clears", () => {
    for (const flow of ["primary", "secondary", "conversion"] as const) {
      expect(runtimePauseNotice(flow, 0)).toBeNull();
    }
  });

  it("renders a status banner with exits and does not replace page content", () => {
    state.flags = PAUSE_SECONDARY;
    const html = renderToStaticMarkup(createElement("div", null,
      createElement(RuntimePauseNotice, { path: "/portfolio/offers" }),
      createElement("button", null, "Cancel existing offer"),
    ));
    expect(html).toContain('role="status"');
    expect(html).toContain('data-runtime-pause-notice="paused"');
    expect(html).toContain("Trading through Manci is paused");
    expect(html).toContain("Cancel existing offer");
    expect(html).toContain("eligible cancellations");
  });

  it("does not read chain status on unrelated routes", () => {
    state.reads.mockClear();
    expect(renderToStaticMarkup(createElement(RuntimePauseNotice, { path: "/account" }))).toBe("");
    expect(state.reads).not.toHaveBeenCalled();
  });

  it("combines lifecycle pauses on the issuer overview and progress pages", () => {
    expect(runtimePauseFlows("/issuer")).toEqual(["primary", "secondary", "conversion"]);
    expect(runtimePauseFlows("/issuer/status/")).toEqual(["primary", "secondary", "conversion"]);
    const notice = combinedRuntimePauseNotice(runtimePauseFlows("/issuer"), 126);
    expect(notice?.description).toContain("primary sales");
    expect(notice?.description).toContain("secondary trading");
    expect(notice?.description).toContain("conversion deposits");
    expect(combinedRuntimePauseNotice(runtimePauseFlows("/issuer"), null)?.tone).toBe("unknown");
    expect(combinedRuntimePauseNotice([], null)).toBeNull();
  });

  it("omits switched-off modules from the issuer aggregate", () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURE_SECONDARY_TRADING", "false");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_CUSTODY_CONVERSION", "false");
    state.flags = 126;
    const html = renderToStaticMarkup(createElement(RuntimePauseNotice, { path: "/issuer" }));
    expect(html).toContain("Primary sales are paused");
    expect(html).not.toContain("OTC offers");
    expect(html).not.toContain("conversion vaults");
  });
});
