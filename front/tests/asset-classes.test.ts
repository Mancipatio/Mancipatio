// Offered asset classes (lib/asset-classes.ts, owner decision 2026-10-10):
// on mainnet the public lists of asset classes show Equity only unless
// NEXT_PUBLIC_ASSET_CLASSES says otherwise; elsewhere every class. A
// production build refuses an unknown slug. The overview tiles and filter,
// /markets/types and the footer list only the offered classes (then a
// non-interactive "More asset classes coming later"); the guide of a class
// that is not offered keeps its URL and shows a notice (noindex). Data of
// existing assets is never filtered.
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@solana/react-hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@solana/react-hooks")>()),
  useSolanaClient: () => ({ runtime: { rpc: {} } }),
  useWalletConnection: () => ({ connected: false, wallet: null }),
}));
vi.mock("@/components/account-menu", () => ({ AccountMenu: () => null }));
vi.mock("@/components/wallet-required", () => ({ WalletRequired: () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) =>
    createElement("a", { href, className }, children),
}));
// The overview loads the registry in an effect, which a static render never runs.
vi.mock("@/lib/indexer", () => ({ loadNetworkPreferIndexer: vi.fn() }));
vi.mock("@/lib/enumerate", () => ({ loadNetwork: vi.fn() }));
vi.mock("@/lib/archive-client", () => ({ withoutArchived: vi.fn() }));
vi.mock("@/lib/vesting-series", () => ({
  loadPositionsForWallet: vi.fn(), loadSeriesByPda: vi.fn(), positionClaimable: vi.fn(), VestingSeriesStatus: { Cancelled: 3 },
}));

import { CATEGORY_SLUGS } from "@/lib/asset-types";
import { ASSET_CLASS_SLUGS, parseAssetClassList } from "@/lib/asset-classes";
import { ASSET_CLASS_NOT_OFFERED, MORE_ASSET_CLASSES_LATER, navHrefVisible, offeredAssetClasses } from "@/lib/pilot-scope";
import { assertBuildAssetClasses } from "@/next.config";
import { KYC_ONLY_ENV } from "@/lib/features";
import { INSTRUMENT_LIST } from "@/lib/instruments";
import { MarketOverview } from "@/components/market-overview";
import InstrumentsIndexPage from "@/app/(marketing)/markets/types/page";
import InstrumentPage, { generateMetadata } from "@/app/(marketing)/markets/types/[slug]/page";
import CategoryMarketPage, { generateMetadata as categoryMetadata } from "@/app/(marketing)/markets/[slug]/page";
import SolutionPage from "@/app/(marketing)/solutions/[slug]/page";

const BUILD = "phase-production-build";
const html = (node: ReactNode) => renderToStaticMarkup(node as never);
const hrefs = (markup: string) => [...markup.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
const visibleText = (markup: string) => markup.replace(/<[^>]+>/g, "").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&");

function network(name: "mainnet" | "devnet", classes = "", kyc = "") {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", name);
  vi.stubEnv("NEXT_PUBLIC_ASSET_CLASSES", classes);
  vi.stubEnv(KYC_ONLY_ENV, kyc);
}

beforeEach(() => network("mainnet"));
afterEach(() => vi.unstubAllEnvs());

describe("lib/asset-classes.ts", () => {
  it("spells out lib/asset-types.tsx CATEGORY_SLUGS, in the same order", () => {
    expect([...ASSET_CLASS_SLUGS]).toEqual([...CATEGORY_SLUGS]);
  });

  it("parses the variable: unset, all, a list in display order, and refuses what names no class", () => {
    expect(parseAssetClassList(undefined)).toEqual({ ok: true, set: false });
    expect(parseAssetClassList("  ")).toEqual({ ok: true, set: false });
    expect(parseAssetClassList("all")).toEqual({ ok: true, set: true, classes: ASSET_CLASS_SLUGS });
    expect(parseAssetClassList(" Equity , DEBT ")).toEqual({ ok: true, set: true, classes: ["equity", "debt"] });
    expect(parseAssetClassList("debt equity")).toEqual({ ok: true, set: true, classes: ["equity", "debt"] });
    const bonds = parseAssetClassList("equity,bonds");
    expect(bonds.ok).toBe(false);
    expect(bonds.ok === false && bonds.error).toMatch(/"bonds"/);
    expect(parseAssetClassList("none").ok).toBe(false);
    expect(parseAssetClassList(",").ok).toBe(false);
  });

  it("the build refuses an unknown class on any network, and only in a production build", () => {
    for (const net of ["mainnet", "devnet"]) {
      expect(() => assertBuildAssetClasses(BUILD, { NEXT_PUBLIC_NETWORK: net, NEXT_PUBLIC_ASSET_CLASSES: "bonds" })).toThrow(/NEXT_PUBLIC_ASSET_CLASSES/);
      for (const value of [undefined, "all", "equity"]) {
        expect(() => assertBuildAssetClasses(BUILD, { NEXT_PUBLIC_NETWORK: net, NEXT_PUBLIC_ASSET_CLASSES: value })).not.toThrow();
      }
    }
    expect(() => assertBuildAssetClasses("phase-development-server", { NEXT_PUBLIC_ASSET_CLASSES: "bonds" })).not.toThrow();
  });

  it("offers equity on mainnet and every class elsewhere by default", () => {
    expect(offeredAssetClasses("mainnet")).toEqual(["equity"]);
    expect(offeredAssetClasses("devnet")).toEqual(ASSET_CLASS_SLUGS);
    network("mainnet", "all");
    expect(offeredAssetClasses("mainnet")).toEqual(ASSET_CLASS_SLUGS);
  });

  it("navHrefVisible hides the guide of a class that is not offered, nothing else", () => {
    for (const href of ["/markets/types/debt", "/markets/debt"]) expect(navHrefVisible(href, "mainnet"), href).toBe(false);
    for (const href of ["/markets/types/equity", "/markets/types", "/markets/resell", "/markets/whitepapers", "/markets/equity"]) {
      expect(navHrefVisible(href, "mainnet"), href).toBe(href !== "/markets/resell");
    }
    network("devnet");
    for (const href of ["/markets/types/debt", "/markets/debt", "/markets/types/other", "/markets/types"]) {
      expect(navHrefVisible(href, "devnet"), href).toBe(true);
    }
  });
});

describe("the overview's asset classes (components/market-overview.tsx)", () => {
  const categoryButtons = (markup: string) => [...markup.matchAll(/<button[^>]*class="overview-category[ "][^>]*>(.*?)<\/button>/g)].map((m) => m[1]);
  const options = (markup: string) => {
    const select = markup.slice(markup.indexOf('aria-label="Asset category"'));
    return [...select.slice(0, select.indexOf("</select>")).matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  };
  const tabs = (markup: string) => {
    const start = markup.indexOf('class="overview-market-tabs"');
    return markup.slice(start, markup.indexOf("</div>", start));
  };

  it("mainnet default (KYC-only on): one Equity tile, then a tile that is not a control; no sales tab or raise link", () => {
    const markup = html(createElement(MarketOverview));
    const buttons = categoryButtons(markup);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain("Equity");
    const later = markup.slice(markup.indexOf("overview-category--later"));
    expect(markup.match(/overview-category--later/g)).toHaveLength(1);
    // Not a control and no ARIA name on a generic div (its text is read).
    expect(markup).toMatch(/<div class="overview-category overview-category--later" title="More asset classes coming later">/);
    expect(later).toContain("More asset classes");
    expect(later).toContain("Coming later");
    expect(options(markup)).toEqual(["all", "0"]);
    expect(tabs(markup)).not.toContain("Primary sales");
    expect(hrefs(markup)).not.toContain("/marketplace/launchpad");
    expect(hrefs(markup)).not.toContain("/apply");
    expect(markup).toContain("overview-categories overview-categories--few");
  });

  it("devnet: the eight classes, no 'coming later' tile, and the primary sales tab", () => {
    network("devnet");
    const markup = html(createElement(MarketOverview));
    expect(categoryButtons(markup)).toHaveLength(8);
    expect(markup).not.toContain("Coming later");
    expect(options(markup)).toHaveLength(9);
    expect(tabs(markup)).toContain("Primary sales");
  });
});

describe("the asset guides (/markets/types)", () => {
  it("a class that is not offered: the notice and noindex, no fact sheet; equity keeps its fact sheet", async () => {
    const debt = html(await InstrumentPage({ params: Promise.resolve({ slug: "debt" }) }));
    expect(debt).toContain(ASSET_CLASS_NOT_OFFERED);
    expect(debt).not.toContain("What it is");
    expect(hrefs(debt)).toEqual(["/markets/types"]);
    // The root layout's noindex, nofollow stays where indexing is not allowed
    // (a page's robots would replace it); a noindex only where it is.
    const meta = await generateMetadata({ params: Promise.resolve({ slug: "debt" }) });
    expect((meta as { robots?: unknown }).robots).toBeUndefined();
    vi.stubEnv("NEXT_PUBLIC_ALLOW_INDEXING", "true");
    vi.stubEnv("VERCEL_ENV", "");
    const indexed = await generateMetadata({ params: Promise.resolve({ slug: "debt" }) });
    expect((indexed as { robots?: unknown }).robots).toEqual({ index: false, follow: true });
    const equity = html(await InstrumentPage({ params: Promise.resolve({ slug: "equity" }) }));
    expect(equity).toContain("What it is");
    expect(equity).not.toContain(ASSET_CLASS_NOT_OFFERED);
    expect((await generateMetadata({ params: Promise.resolve({ slug: "equity" }) }) as { robots?: unknown }).robots).toBeUndefined();
  });

  it("a market page of a class that is not offered: the notice and noindex, only the way back", async () => {
    const debt = html(await CategoryMarketPage({ params: Promise.resolve({ slug: "debt" }) }));
    expect(debt).toContain(ASSET_CLASS_NOT_OFFERED);
    expect(hrefs(debt)).toEqual(["/marketplace"]);
    expect(((await categoryMetadata({ params: Promise.resolve({ slug: "debt" }) })) as { robots?: unknown }).robots).toBeUndefined();
    vi.stubEnv("NEXT_PUBLIC_ALLOW_INDEXING", "true");
    vi.stubEnv("VERCEL_ENV", "");
    expect(((await categoryMetadata({ params: Promise.resolve({ slug: "debt" }) })) as { robots?: unknown }).robots).toEqual({ index: false, follow: true });
  });

  it("the index on mainnet: the equity card and rows only, then 'more asset classes coming later'", () => {
    const markup = html(createElement(InstrumentsIndexPage));
    expect(hrefs(markup).filter((href) => href.startsWith("/markets/types/"))).toEqual(["/markets/types/equity"]);
    expect(markup).toContain(MORE_ASSET_CLASSES_LATER);
    // Not a link, and drawn apart from the instrument cards (dashed, muted).
    expect(markup).toMatch(new RegExp(`<div class="mx-card border-dashed[^"]*"><h3 class="mx-h3">${MORE_ASSET_CLASSES_LATER}</h3></div>`));
    // KYC-only mode (mainnet default): applications are paused, the contact form is not.
    expect(markup).not.toContain("reads every application");
    expect(markup).toContain("reads every message");
    const equity = INSTRUMENT_LIST.find((i) => i.slug === "equity")!;
    for (const set of equity.terms) expect(markup).toContain(set.right);
    for (const other of INSTRUMENT_LIST.filter((i) => i.slug !== "equity")) {
      for (const set of other.terms) expect(markup, other.slug).not.toContain(set.right);
    }
    expect(markup).not.toContain("Real estate appears twice");
  });

  it("the index with every class offered: the eight cards and no 'coming later' card", () => {
    network("devnet");
    const markup = html(createElement(InstrumentsIndexPage));
    expect(hrefs(markup).filter((href) => href.startsWith("/markets/types/"))).toHaveLength(8);
    expect(markup).not.toContain(MORE_ASSET_CLASSES_LATER);
    expect(markup).toContain("Real estate appears twice");
    expect(markup).toContain("reads every application");
  });
});

describe("the tokenization guide names the offered asset types (/solutions/tokenization)", () => {
  const guide = async () => visibleText(html(await SolutionPage({ params: Promise.resolve({ slug: "tokenization" }) })));

  it("one class: singular; several: joined with 'and' (a set, not a choice); every class: today's sentence", async () => {
    expect(await guide()).toContain("Equity is the asset type Manci offers at the moment.");
    network("mainnet", "equity,debt");
    expect(await guide()).toContain("Equity and debt are the asset types Manci offers at the moment.");
    network("mainnet", "equity,debt,royalty");
    expect(await guide()).toContain("Equity, royalty and debt are the asset types Manci offers at the moment.");
    network("devnet");
    expect(await guide()).toContain("Choose equity, revenue share, royalty, real estate, debt, commodity, physical good or other.");
  });
});
