// The sitemap (app/sitemap.ts): the public marketing and documentation pages
// this deployment shows. Directive-free and pure, like lib/indexing.ts.
//
// Empty unless this build may be indexed (lib/indexing.ts indexingAllowed: a
// mainnet production build with NEXT_PUBLIC_ALLOW_INDEXING=true), so a devnet
// or Preview deployment advertises nothing; robots.txt names the sitemap only
// in that same case (app/robots.ts).
//
// A page is listed only when crawlers may fetch it (nothing under
// NON_INDEXED_PATHS, which robots.txt disallows: signed-in workspaces, admin
// tooling, sign-in and the API) and this network shows it (navHrefVisible,
// lib/pilot-scope.ts): the pages of switched-off modules, of what KYC-only
// mode pauses and of asset classes that are not offered stay out. Those pages
// carry `noindex` themselves when indexing is allowed (the solution guides,
// the asset-class pages, /markets/resell), so the sitemap and the pages
// agree. No geoblocked page is listed (lib/geoblock.ts
// GEOBLOCKED_PAGE_PREFIXES): a crawler in a listed country would be shown the
// noindex notice instead. Every page of the route tree is either listed here
// or in SITEMAP_EXCLUDED with its reason (tests/seo-metadata.test.ts walks
// app/).

import type { MetadataRoute } from "next";
import { ASSET_CLASS_SLUGS } from "@/lib/asset-classes";
import { geoblockKind } from "@/lib/geoblock";
import { indexingAllowed, NON_INDEXED_PATHS } from "@/lib/indexing";
import { detectNetwork, type Network } from "@/lib/network";
import { navHrefVisible } from "@/lib/pilot-scope";
import { siteHref, siteUrl } from "@/lib/site-url";
import { SOLUTIONS } from "@/lib/solutions";

type Frequency = "weekly" | "monthly" | "yearly";
export type SitemapPage = { path: string; changeFrequency: Frequency; priority: number };

const page = (path: string, changeFrequency: Frequency, priority: number): SitemapPage => ({ path, changeFrequency, priority });

/** The fixed public pages: the landing page, the app overview, the guides and the legal texts. */
export const SITEMAP_PAGES: readonly SitemapPage[] = [
  page("/", "weekly", 1),
  page("/app", "weekly", 0.7),
  page("/about", "monthly", 0.7),
  page("/docs", "monthly", 0.7),
  page("/docs/manci-answers", "monthly", 0.6),
  page("/docs/pilot", "monthly", 0.3),
  page("/investors", "monthly", 0.6),
  page("/how-it-works", "monthly", 0.6),
  page("/faq", "monthly", 0.6),
  page("/markets/types", "monthly", 0.6),
  page("/markets/whitepapers", "weekly", 0.6),
  page("/markets/resell", "weekly", 0.5),
  page("/legal-structure", "monthly", 0.5),
  // Guides outside /solutions/[slug]; each leaves the list when its scope is off (navHrefVisible).
  page("/solutions/serbian-spv", "monthly", 0.5),
  page("/solutions/esop", "monthly", 0.5),
  page("/security", "monthly", 0.5),
  page("/risks", "monthly", 0.5),
  page("/pricing", "monthly", 0.5),
  page("/contact", "yearly", 0.4),
  page("/certificates/verify", "yearly", 0.3),
  page("/legal/company", "yearly", 0.3),
  page("/legal/terms", "yearly", 0.3),
  page("/legal/privacy", "yearly", 0.3),
];

/** The dynamic families, one page per slug, as their generateStaticParams list them. */
export const SITEMAP_FAMILIES: Readonly<Record<string, readonly SitemapPage[]>> = {
  "/markets/types/[slug]": ASSET_CLASS_SLUGS.map((slug) => page(`/markets/types/${slug}`, "monthly", 0.6)),
  "/markets/[slug]": ASSET_CLASS_SLUGS.map((slug) => page(`/markets/${slug}`, "weekly", 0.5)),
  "/solutions/[slug]": SOLUTIONS.map((solution) => page(`/solutions/${solution.slug}`, "monthly", 0.5)),
};

/**
 * Public routes that are deliberately not listed, with the reason. Routes
 * under NON_INDEXED_PATHS need no entry.
 */
export const SITEMAP_EXCLUDED: Readonly<Record<string, string>> = {
  "/platform": "redirects to /docs",
  "/solutions": "redirects to /docs#platform-tools",
  "/not-available": "the geoblock notice, noindex",
  "/apply": "the raise application form, geoblocked (lib/geoblock.ts): a crawler in a listed country gets the noindex notice; /how-it-works is the guide to issuing",
  "/marketplace": "client-rendered registry view without page metadata of its own",
  "/marketplace/assets/[id]": "one page per asset, rendered in the browser from the chain; no server-side list to build it from",
  "/marketplace/issuers/[id]": "one page per issuer, rendered in the browser from the chain; no server-side list to build it from",
  "/marketplace/launchpad": "client-rendered sale list without page metadata of its own",
  "/marketplace/launchpad/[sale]": "one page per sale, rendered in the browser from the chain",
  "/marketplace/otc": "client-rendered offer board without page metadata of its own",
  "/marketplace/otc/[offer]": "one page per offer, rendered in the browser from the chain",
  "/marketplace/governance": "client-rendered proposal board without page metadata of its own",
};

/** True for a path robots.txt asks crawlers to skip (its prefix rule). */
export function nonIndexedPath(path: string): boolean {
  return NON_INDEXED_PATHS.some((prefix) => path.startsWith(prefix));
}

/** The pages `network` shows and crawlers may fetch, fixed pages first. */
export function sitemapPages(network: Network = detectNetwork()): SitemapPage[] {
  return [...SITEMAP_PAGES, ...Object.values(SITEMAP_FAMILIES).flat()]
    .filter((entry) => !nonIndexedPath(entry.path) && geoblockKind(entry.path) === null && navHrefVisible(entry.path, network));
}

/** The sitemap of this deployment: empty unless it may be indexed. */
export function sitemapEntries({
  allowed = indexingAllowed(),
  network = detectNetwork(),
  origin = siteUrl(),
}: { allowed?: boolean; network?: Network; origin?: string } = {}): MetadataRoute.Sitemap {
  if (!allowed) return [];
  return sitemapPages(network).map(({ path, changeFrequency, priority }) => ({
    url: siteHref(path, origin),
    changeFrequency,
    priority,
  }));
}
