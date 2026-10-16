import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ASSET_CLASS_SLUGS, offeredAssetClassesFor, parseAssetClassList } from "@/lib/asset-classes";
import { CATEGORY_SLUGS } from "@/lib/asset-types";
import { assetClassOffered, navHrefVisible } from "@/lib/pilot-scope";
import { PILOT_MODULE_ENV } from "@/lib/features";
import { assertBuildAssetClasses } from "@/next.config";

vi.mock("next/navigation", () => ({ usePathname: () => "/docs", useRouter: () => ({ push: vi.fn() }), notFound: () => { throw new Error("not found"); } }));
vi.mock("@/components/account-menu", () => ({ AccountMenu: () => null }));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
  vi.stubEnv("NEXT_PUBLIC_ASSET_CLASSES", "");
  for (const env of Object.values(PILOT_MODULE_ENV)) vi.stubEnv(env, "false");
  vi.resetModules();
});
afterEach(() => vi.unstubAllEnvs());

function links(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
}

function expectOnlyActiveLinks(html: string) {
  for (const href of links(html)) expect(navHrefVisible(href), href).toBe(true);
  for (const slug of ASSET_CLASS_SLUGS.filter((slug) => slug !== "equity")) {
    expect(html).not.toContain(`/markets/types/${slug}`);
  }
}

describe("offered asset classes", () => {
  it("uses the canonical class slugs and preserves test-network coverage", () => {
    expect(ASSET_CLASS_SLUGS).toEqual(CATEGORY_SLUGS);
    expect(offeredAssetClassesFor("mainnet", undefined)).toEqual(["equity"]);
    expect(offeredAssetClassesFor("devnet", undefined)).toEqual(ASSET_CLASS_SLUGS);
    expect(assetClassOffered("debt", "mainnet")).toBe(false);
    expect(navHrefVisible("/markets/types/debt?from=docs", "mainnet")).toBe(false);
    expect(navHrefVisible("/markets/debt", "mainnet")).toBe(false);
    expect(navHrefVisible("/markets/types/debt/?from=docs", "mainnet")).toBe(false);
    expect(navHrefVisible("/marketplace/launchpad", "mainnet")).toBe(true);
    expect(navHrefVisible("/issuer/assets", "mainnet")).toBe(true);
    expect(navHrefVisible("/portfolio/history", "mainnet")).toBe(true);
  });

  it("validates class overrides before production builds", () => {
    expect(parseAssetClassList(" debt, EQUITY debt ")).toEqual({ ok: true, set: true, classes: ["equity", "debt"] });
    expect(() => assertBuildAssetClasses("phase-production-build", { NEXT_PUBLIC_ASSET_CLASSES: "eqity" })).toThrow(/unknown asset class/);
    expect(() => assertBuildAssetClasses("phase-production-build", { NEXT_PUBLIC_ASSET_CLASSES: "all" })).not.toThrow();
    expect(offeredAssetClassesFor("mainnet", "equity,debt")).toEqual(["equity", "debt"]);
  });
});

describe("public rendering follows the active scope", () => {
  it("the footer and asset-type index advertise only Equity and keep primary issuance open", async () => {
    const [{ SiteFooter }, { default: AssetTypes }] = await Promise.all([
      import("@/components/mx/site-footer"), import("@/app/(marketing)/markets/types/page"),
    ]);
    const footer = renderToStaticMarkup(createElement(SiteFooter));
    const types = renderToStaticMarkup(createElement(AssetTypes));
    expectOnlyActiveLinks(footer);
    expectOnlyActiveLinks(types);
    expect(links(types)).toContain("/markets/types/equity");
    expect(links(types)).toContain("/apply");
    expect(types).not.toContain("More asset classes");
    expect(types).not.toContain("Real estate");
    expect(footer).not.toContain("/markets/resell");
  });

  it("desktop and mobile documentation hide suspended modules together", async () => {
    const [{ DocumentationFrame }, { DocumentationIndex }] = await Promise.all([
      import("@/components/documentation-frame"), import("@/components/documentation-index"),
    ]);
    const frame = renderToStaticMarkup(createElement(DocumentationFrame, null, "Article"));
    const index = renderToStaticMarkup(createElement(DocumentationIndex));
    expectOnlyActiveLinks(frame);
    expectOnlyActiveLinks(index);
    for (const html of [frame, index]) {
      expect(html).toContain("/solutions/launchpad");
      expect(html).not.toContain("/solutions/rights-vesting");
      expect(html).not.toContain("/solutions/governance");
      expect(html).not.toContain("/solutions/custody");
    }
    expect(frame).not.toContain('value="/solutions/otc"');
  });

  it("secondary trading and holder conversion reappear when enabled without physical delivery", async () => {
    vi.stubEnv(PILOT_MODULE_ENV.secondaryTrading, "true");
    vi.stubEnv(PILOT_MODULE_ENV.custodyConversion, "true");
    const [{ DocumentationIndex }, { default: HowItWorks }, { default: Investors }, { default: Solution }] = await Promise.all([
      import("@/components/documentation-index"), import("@/app/(marketing)/how-it-works/page"),
      import("@/app/(marketing)/investors/page"), import("@/app/(marketing)/solutions/[slug]/page"),
    ]);
    const docs = renderToStaticMarkup(createElement(DocumentationIndex));
    const issuerGuide = renderToStaticMarkup(createElement(HowItWorks));
    const investorGuide = renderToStaticMarkup(createElement(Investors));
    const conversionGuide = renderToStaticMarkup(await Solution({ params: Promise.resolve({ slug: "custody" }) }));
    expect(docs).toContain("/solutions/otc");
    expect(docs).toContain("Token conversion");
    expect(docs).not.toContain("Custody &amp; delivery");
    expect(issuerGuide).toContain("/portfolio/conversion");
    expect(issuerGuide.indexOf("Complete KYC or KYB")).toBeLessThan(issuerGuide.indexOf("Request token issuance"));
    expect(investorGuide).toContain("/portfolio/conversion");
    expect(investorGuide).toContain("/marketplace/otc");
    expect(conversionGuide).toContain("Open conversion requests");
    expect(conversionGuide).not.toContain("Physical delivery");
    expect(conversionGuide).not.toContain("/portfolio/delivery");
  });

  it("direct unsupported class URLs show a notice and do not invite issuance", async () => {
    vi.stubEnv("NEXT_PUBLIC_ALLOW_INDEXING", "true");
    vi.stubEnv("VERCEL_ENV", "production");
    const [instrument, market] = await Promise.all([
      import("@/app/(marketing)/markets/types/[slug]/page"), import("@/app/(marketing)/markets/[slug]/page"),
    ]);
    for (const page of [instrument, market]) {
      const params = Promise.resolve({ slug: "debt" });
      const html = renderToStaticMarkup(await page.default({ params }));
      expect(html).toContain("This asset class is not offered on Manci at the moment.");
      expect(links(html)).not.toContain("/apply");
      expect(await page.generateMetadata({ params })).toMatchObject({ robots: { index: false } });
    }
  });
});
