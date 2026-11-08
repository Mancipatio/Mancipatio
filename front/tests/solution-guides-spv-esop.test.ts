// The two public guides of this change, and their scope:
//   /solutions/esop        — a guide of the vesting pilot module: readable by
//                            URL, with the module notice while the module is
//                            off, never a button into the issuer form then,
//                            and out of the menus (NAV_ROUTES);
//   /solutions/serbian-spv — issuance: while KYC-only mode pauses it, the
//                            page says "Paused.", hides the application
//                            button and leaves the menus
//                            (KYC_ONLY_NAV_PREFIXES).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KYC_ONLY_ENV, KYC_ONLY_MESSAGE, PILOT_MODULE_ENV } from "@/lib/features";
import { navHrefVisible } from "@/lib/pilot-scope";
import { visibleDocumentationGroups } from "@/lib/documentation";
import EsopGuidePage, { generateMetadata as esopMetadata } from "@/app/(marketing)/solutions/esop/page";
import SerbianSpvGuidePage from "@/app/(marketing)/solutions/serbian-spv/page";

afterEach(() => vi.unstubAllEnvs());

function network(name: "mainnet" | "devnet", opts: { kycOnly?: string; vesting?: string } = {}) {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", name);
  vi.stubEnv(KYC_ONLY_ENV, opts.kycOnly ?? "off");
  for (const variable of Object.values(PILOT_MODULE_ENV)) vi.stubEnv(variable, "");
  if (opts.vesting !== undefined) vi.stubEnv(PILOT_MODULE_ENV.vesting, opts.vesting);
}
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
const docs = () => visibleDocumentationGroups().flatMap((g) => g.topics.map((t) => t.href));
const esop = () => renderToStaticMarkup(createElement(EsopGuidePage));
const spv = () => renderToStaticMarkup(createElement(SerbianSpvGuidePage));

describe("/solutions/esop", () => {
  it("module on (devnet): no notice, the button into the vesting-series form, in the docs", () => {
    network("devnet");
    const html = esop();
    expect(html).not.toContain("data-pilot-module-notice");
    expect(hrefs(html)).toContain("/issuer/vesting-series");
    expect(html).toContain("Employee equity (ESOP): 12-month cliff, 48 months total, monthly");
    expect(navHrefVisible("/solutions/esop")).toBe(true);
    expect(docs()).toContain("/solutions/esop");
  });

  it("module off on mainnet: the explainer stays, with the module notice, no form button and no menu entry", () => {
    network("mainnet", { vesting: "" });
    const html = esop();
    expect(html).toContain("data-pilot-module-notice");
    expect(html).toContain("Not available.");
    expect(html).toContain("Vesting series: not available on Solana mainnet.");
    // A guide notice, not a page with exits.
    expect(html).not.toContain("Existing positions can still be closed here");
    expect(hrefs(html)).not.toContain("/issuer/vesting-series");
    expect(hrefs(html)).not.toContain("/portfolio/vesting");
    expect(hrefs(html)).not.toContain("/solutions/rights-vesting");
    expect(html).toContain("How the ESOP preset works");
    expect(navHrefVisible("/solutions/esop")).toBe(false);
    expect(docs()).not.toContain("/solutions/esop");
  });

  it("never claims availability: the copy says where the module is offered", () => {
    network("mainnet", { vesting: "" });
    const html = esop();
    expect(html).toContain("Where the vesting module is offered");
    expect(html).not.toMatch(/available on Manci|now available|is available/i);
  });

  it("module switched on for mainnet: no notice", () => {
    network("mainnet", { vesting: "true" });
    expect(esop()).not.toContain("data-pilot-module-notice");
    expect(navHrefVisible("/solutions/esop")).toBe(true);
  });

  it("KYC-only mode: Paused., with the one sentence", () => {
    network("mainnet", { kycOnly: "", vesting: "true" });
    const html = esop();
    expect(html).toContain("Paused.");
    expect(html).toContain(KYC_ONLY_MESSAGE.replace(/'/g, "&#x27;"));
    expect(hrefs(html)).not.toContain("/issuer/vesting-series");
  });

  it("is kept out of search results while the module is off (where indexing is allowed at all)", () => {
    network("mainnet", { vesting: "" });
    vi.stubEnv("NEXT_PUBLIC_ALLOW_INDEXING", "true");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(esopMetadata().robots).toEqual({ index: false, follow: true });
    vi.stubEnv(PILOT_MODULE_ENV.vesting, "true");
    expect(esopMetadata().robots).toBeUndefined();
  });
});

describe("/solutions/serbian-spv", () => {
  it("issuance open: the application button, the requirements and the costs, in the docs", () => {
    network("mainnet", { kycOnly: "off" });
    const html = spv();
    expect(html).not.toContain("data-pilot-module-notice");
    expect(hrefs(html)).toContain("/apply");
    expect(hrefs(html)).toContain("/contact");
    expect(html).toContain("What you will need to provide");
    expect(html).toContain("quoted per engagement before any work starts");
    expect(html).toContain("Serbian Business Registers Agency (APR)");
    expect(navHrefVisible("/solutions/serbian-spv")).toBe(true);
    expect(docs()).toContain("/solutions/serbian-spv");
  });

  it("KYC-only mode: Paused., no application button, out of the menus", () => {
    network("mainnet", { kycOnly: "" });
    const html = spv();
    expect(html).toContain("Paused.");
    expect(hrefs(html)).not.toContain("/apply");
    expect(navHrefVisible("/solutions/serbian-spv")).toBe(false);
    expect(docs()).not.toContain("/solutions/serbian-spv");
    // Devnet rehearses the mode the same way.
    network("devnet", { kycOnly: "on" });
    expect(navHrefVisible("/solutions/serbian-spv")).toBe(false);
  });

  it("never calls the platform audited and promises no outcome", () => {
    network("devnet");
    const html = spv();
    expect(html).not.toMatch(/audited|guarantee|return on/i);
  });
});
