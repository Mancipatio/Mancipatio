// Search indexing readiness: the site origin (lib/site-url.ts), the sitemap
// (lib/sitemap.ts, app/sitemap.ts), the robots.txt Sitemap line, the root
// layout's metadata defaults (metadata base, canonical, Open Graph, Twitter
// card) and the landing page's Organization JSON-LD (lib/structured-data.ts).
// The sitemap is empty, and robots.txt names it, only as lib/indexing.ts
// decides; the route-tree walk keeps the page list honest.
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createElement, type AnchorHTMLAttributes } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/font/google", () => {
  const font = () => ({ variable: "font" });
  return { Geist: font, Geist_Mono: font, Montserrat: font };
});
vi.mock("next/link", () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => createElement("a", props),
}));
// The root layout's client providers are not under test here.
vi.mock("@/app/providers", () => ({ Providers: () => null }));
vi.mock("@/components/maintenance-banner", () => ({ MaintenanceBanner: () => null }));
vi.mock("@/components/manci-assistant", () => ({ ManciAssistant: () => null }));

import { geoblockKind } from "@/lib/geoblock";
import { NON_INDEXED_PATHS } from "@/lib/indexing";
import { OPERATORS } from "@/lib/legal/operator";
import { KYC_ONLY_ENV, PILOT_MODULE_ENV } from "@/lib/features";
import { DEFAULT_SITE_URL, siteHref, siteUrl } from "@/lib/site-url";
import {
  nonIndexedPath, SITEMAP_EXCLUDED, SITEMAP_FAMILIES, SITEMAP_PAGES, sitemapEntries, sitemapPages,
} from "@/lib/sitemap";
import { jsonLdScript, organizationJsonLd } from "@/lib/structured-data";
import { MANCI_X_HANDLE, MANCI_X_URL } from "@/lib/social";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** A build that may be indexed: mainnet, opted in, Vercel production (or no Vercel). */
function indexedMainnet(siteUrlValue = "https://www.manci.io") {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
  vi.stubEnv("NEXT_PUBLIC_ALLOW_INDEXING", "true");
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", siteUrlValue);
  // As mainnet runs: KYC-only mode on (unset), every module off, equity only.
  vi.stubEnv(KYC_ONLY_ENV, "");
  vi.stubEnv("NEXT_PUBLIC_ASSET_CLASSES", "");
  for (const name of Object.values(PILOT_MODULE_ENV)) vi.stubEnv(name, "");
}

const paths = (entries: { url: string }[], origin = DEFAULT_SITE_URL) =>
  entries.map((entry) => entry.url.slice(origin.length) || "/");

describe("site origin (lib/site-url.ts)", () => {
  it("reads NEXT_PUBLIC_SITE_URL by the mainnet build guard's rule: an https origin, nothing else", () => {
    expect(siteUrl("https://www.manci.io")).toBe("https://www.manci.io");
    expect(siteUrl("https://www.manci.io/")).toBe("https://www.manci.io");
    expect(siteUrl("  https://devnet.manci.io  ")).toBe("https://devnet.manci.io");
    expect(siteUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(siteUrl("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000");
  });

  it("falls back to the production origin instead of throwing on anything else", () => {
    for (const bad of [undefined, "", "   ", "www.manci.io", "not a url", "http://www.manci.io",
      "https://www.manci.io/app", "https://www.manci.io/?ref=1", "https://www.manci.io/#top",
      "https://user:secret@www.manci.io", "ftp://www.manci.io", "javascript:alert(1)"]) {
      expect(siteUrl(bad), String(bad)).toBe(DEFAULT_SITE_URL);
    }
    expect(DEFAULT_SITE_URL).toBe("https://www.manci.io");
  });

  it("builds absolute links on that origin; the home page is the bare origin, as Next.js writes its canonical", () => {
    expect(siteHref("/", "https://www.manci.io")).toBe("https://www.manci.io");
    expect(siteHref("/about", "https://www.manci.io")).toBe("https://www.manci.io/about");
    expect(siteHref("/sitemap.xml", "https://devnet.manci.io")).toBe("https://devnet.manci.io/sitemap.xml");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://devnet.manci.io");
    expect(siteHref("/legal/terms")).toBe("https://devnet.manci.io/legal/terms");
  });
});

describe("sitemap.xml (lib/sitemap.ts)", () => {
  it("is empty whenever indexing is not allowed (devnet, no opt-in, a Vercel Preview)", async () => {
    indexedMainnet();
    vi.stubEnv("VERCEL_ENV", "preview");
    const { default: sitemap } = await import("@/app/sitemap");
    expect(sitemap()).toEqual([]);
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_ALLOW_INDEXING", "");
    expect(sitemap()).toEqual([]);
    vi.stubEnv("NEXT_PUBLIC_ALLOW_INDEXING", "true");
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    expect(sitemap()).toEqual([]);
    expect(sitemapEntries({ allowed: false, network: "mainnet" })).toEqual([]);
  });

  it("lists the public pages of an opted-in mainnet build on the configured origin, none of them non-indexed", async () => {
    indexedMainnet();
    const { default: sitemap } = await import("@/app/sitemap");
    const entries = sitemap();
    expect(entries.length).toBeGreaterThan(10);
    expect(entries.every((entry) => entry.url === DEFAULT_SITE_URL || entry.url.startsWith(`${DEFAULT_SITE_URL}/`))).toBe(true);
    const listed = paths(entries);
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed[0]).toBe("/");
    expect(entries[0]).toMatchObject({ url: "https://www.manci.io", priority: 1 });
    for (const path of ["/about", "/docs", "/investors", "/how-it-works", "/faq", "/markets/types", "/markets/types/equity",
      "/markets/equity", "/markets/whitepapers", "/security", "/risks", "/legal/terms", "/legal/privacy", "/legal/company"]) {
      expect(listed, path).toContain(path);
    }
    for (const path of listed) {
      expect(NON_INDEXED_PATHS.some((prefix) => path.startsWith(prefix)), path).toBe(false);
      expect(geoblockKind(path), path).toBeNull();
    }
  });

  it("leaves out what mainnet does not show: KYC-only pauses, switched-off modules, classes not offered", async () => {
    indexedMainnet();
    const listed = paths(sitemapEntries());
    for (const path of ["/apply", "/markets/resell", "/solutions/otc", "/solutions/governance", "/solutions/rights-vesting",
      "/solutions/custody", "/solutions/tokenization", "/solutions/issuer-registry", "/solutions/share-classes",
      "/solutions/launchpad", "/markets/types/debt", "/markets/debt", "/marketplace", "/platform", "/not-available"]) {
      expect(listed, path).not.toContain(path);
    }
    // The guide that stays open under KYC-only mode is listed.
    expect(listed).toContain("/solutions/compliance");
    // Leaving KYC-only mode with secondary trading on: its pages come back.
    vi.stubEnv(KYC_ONLY_ENV, "false");
    vi.stubEnv(PILOT_MODULE_ENV.secondaryTrading, "true");
    const opened = paths(sitemapEntries());
    expect(opened).toEqual(expect.arrayContaining(["/markets/resell", "/solutions/otc", "/solutions/tokenization"]));
    expect(opened).not.toContain("/solutions/governance");
  });

  it("follows the configured site origin", async () => {
    indexedMainnet("https://example.manci.test/");
    const { default: sitemap } = await import("@/app/sitemap");
    const urls = sitemap().map((entry) => entry.url);
    expect(urls[0]).toBe("https://example.manci.test");
    expect(urls.every((url) => url === "https://example.manci.test" || url.startsWith("https://example.manci.test/"))).toBe(true);
  });

  it("a test network with every module on lists every guide (the page list itself, independent of the switch)", () => {
    const listed = sitemapPages("devnet").map((entry) => entry.path);
    expect(listed).toEqual(expect.arrayContaining(["/markets/resell", "/solutions/otc", "/solutions/governance",
      "/markets/types/debt", "/markets/other"]));
    expect(listed.some(nonIndexedPath)).toBe(false);
  });
});

/** Every page.tsx under app/, as its route (route groups dropped). */
function appRoutes(): string[] {
  const root = join(process.cwd(), "app");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry === "page.tsx" || entry === "page.ts") {
        const segments = relative(root, dir).split(sep).filter((s) => s && !/^\(.*\)$/.test(s));
        out.push(`/${segments.join("/")}`);
      }
    }
  };
  walk(root);
  return out.sort();
}

describe("the sitemap and the route tree", () => {
  const routes = appRoutes();
  const families = Object.keys(SITEMAP_FAMILIES);
  const fixed = SITEMAP_PAGES.map((entry) => entry.path);

  it("classifies every public page: listed, a listed family, or excluded with a reason", () => {
    const unclassified = routes.filter((route) => !nonIndexedPath(route)
      && !fixed.includes(route) && !families.includes(route) && !(route in SITEMAP_EXCLUDED));
    expect(unclassified, "add the page to lib/sitemap.ts (SITEMAP_PAGES, or SITEMAP_EXCLUDED with why)").toEqual([]);
    expect(routes).toContain("/");
  });

  it("names only pages that exist, never a non-indexed or geoblocked one, and excludes nothing it lists", () => {
    for (const path of [...fixed, ...families, ...Object.keys(SITEMAP_EXCLUDED)]) expect(routes, path).toContain(path);
    for (const path of [...fixed, ...families]) {
      expect(nonIndexedPath(path), path).toBe(false);
      expect(geoblockKind(path.replace(/\[[^\]]+\]/, "x")), path).toBeNull();
      expect(path in SITEMAP_EXCLUDED, path).toBe(false);
    }
    expect(Object.values(SITEMAP_EXCLUDED).every((why) => why.trim().length > 10)).toBe(true);
    expect(new Set(fixed).size).toBe(fixed.length);
  });

  it("lists each dynamic family exactly as its generateStaticParams", async () => {
    const pages: Record<string, () => Promise<{ generateStaticParams: () => unknown }>> = {
      "/markets/types/[slug]": () => import("@/app/(marketing)/markets/types/[slug]/page"),
      "/markets/[slug]": () => import("@/app/(marketing)/markets/[slug]/page"),
      "/solutions/[slug]": () => import("@/app/(marketing)/solutions/[slug]/page"),
    };
    expect(Object.keys(pages).sort()).toEqual([...families].sort());
    for (const family of families) {
      const params = (await (await pages[family]()).generateStaticParams()) as { slug: string }[];
      expect(SITEMAP_FAMILIES[family].map((entry) => entry.path), family)
        .toEqual(params.map(({ slug }) => family.replace("[slug]", slug)));
    }
  });
});

describe("robots.txt names the sitemap only when indexing is allowed", () => {
  it("opted-in mainnet production: the sitemap on the configured origin", async () => {
    indexedMainnet();
    const { default: robots } = await import("@/app/robots");
    expect(robots().sitemap).toBe("https://www.manci.io/sitemap.xml");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://example.manci.test");
    expect(robots().sitemap).toBe("https://example.manci.test/sitemap.xml");
  });

  it("everywhere else: no Sitemap line, only Disallow: /", async () => {
    indexedMainnet();
    const { default: robots } = await import("@/app/robots");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    expect(robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
  });
});

describe("root layout metadata", () => {
  it("bases canonical, og:url and og:image on the configured origin; every page names itself canonical", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.manci.io");
    const { metadata } = await import("@/app/layout");
    expect(String(metadata.metadataBase)).toBe("https://www.manci.io/");
    expect(metadata.alternates).toEqual({ canonical: "./" });
    expect(metadata.openGraph).toMatchObject({ type: "website", siteName: "Manci", locale: "en_US", url: "./" });
    // Pages fill og:title / og:description from their own: the layout sets none.
    expect(metadata.openGraph).not.toHaveProperty("title");
    expect(metadata.openGraph).not.toHaveProperty("description");
    expect(metadata.twitter).toEqual({ card: "summary_large_image", site: MANCI_X_HANDLE });
    expect(MANCI_X_HANDLE).toBe("@Manci_rwa");
  });

  it("follows NEXT_PUBLIC_SITE_URL, and a malformed value no longer breaks every page", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://devnet.manci.io");
    expect(String((await import("@/app/layout")).metadata.metadataBase)).toBe("https://devnet.manci.io/");
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "devnet.manci.io");
    expect(String((await import("@/app/layout")).metadata.metadataBase)).toBe("https://www.manci.io/");
  });

  it("default title and description claim no module that may be off", async () => {
    const { metadata } = await import("@/app/layout");
    const copy = `${String(metadata.title)} ${String(metadata.description)}`;
    expect(copy).not.toMatch(/\b(trad(e|es|ing)|vest(s|ing)?|custod(y|ies)|audit(ed)?)\b/i);
    expect(copy).toMatch(/company shares|shares of private companies/);
  });

  it("a missing page names no canonical URL and no og:url", async () => {
    const { metadata } = await import("@/app/not-found");
    expect(metadata.alternates).toEqual({ canonical: null });
    expect(metadata.openGraph).toEqual({ type: "website", siteName: "Manci", locale: "en_US" });
  });
});

describe("Organization JSON-LD (lib/structured-data.ts)", () => {
  it("mainnet: the operator record's entity, the site and the X account", () => {
    expect(organizationJsonLd(OPERATORS.mainnet, "https://www.manci.io")).toEqual({
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Manci",
      legalName: "Manci International Ltd.",
      url: "https://www.manci.io",
      logo: "https://www.manci.io/icon",
      sameAs: [MANCI_X_URL],
      address: OPERATORS.mainnet.registeredOffice,
      // The tax ID is { notAssigned }: never an identifier.
      identifier: [{ "@type": "PropertyValue", propertyID: "BVI company number", value: "2219023" }],
    });
  });

  it("without a legal entity (the devnet pilot): the brand only", () => {
    expect(organizationJsonLd(OPERATORS.devnet, "https://devnet.manci.io")).toEqual({
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Manci",
      url: "https://devnet.manci.io",
      logo: "https://devnet.manci.io/icon",
      sameAs: [MANCI_X_URL],
    });
  });

  it("escapes < so no value can close the script element; the JSON reads back unchanged", () => {
    const data = { name: "</script><script>alert(1)</script>", nested: { note: "a < b" } };
    const text = jsonLdScript(data);
    expect(text).not.toContain("<");
    expect(JSON.parse(text)).toEqual(data);
  });

  it("the landing page carries one Organization block on the configured origin", async () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.manci.io");
    const { default: HomePage } = await import("@/app/page");
    const markup = renderToStaticMarkup(createElement(HomePage));
    const blocks = [...markup.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(blocks).toHaveLength(1);
    expect(JSON.parse(blocks[0])).toEqual(organizationJsonLd(OPERATORS.mainnet, "https://www.manci.io"));
  });
});
