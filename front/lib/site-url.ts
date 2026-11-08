// The public origin of the site, for URLs that leave the page: the metadata
// base (canonical links, og:url, og:image), the sitemap and the robots.txt
// Sitemap line; and the Open Graph fields every page shares. Directive-free
// and pure, like lib/indexing.ts.
//
// NEXT_PUBLIC_SITE_URL is the one setting (ops/env-vars.md). A mainnet
// production build already refuses a value that is not an https origin
// (next.config.ts MAINNET_OPS_REQUIREMENTS "site-url"); this reads it with the
// same rule, so a page never advertises another host. Anything else falls
// back to the production origin instead of throwing at module load (the old
// `new URL(process.env.NEXT_PUBLIC_SITE_URL || …)` in the root layout broke
// every page on a malformed value): a deployment that may be indexed
// (lib/indexing.ts) is a mainnet production build, where the guard holds
// unless it was waived on purpose, and every other deployment is noindex.
// http is accepted for a loopback host only (local previews).
//
// Email links and OAuth redirects keep their own, stricter reader
// (lib/server/account-origin.ts): they answer 503 rather than fall back.

export const DEFAULT_SITE_URL = "https://www.manci.io";

/**
 * The Open Graph fields every page shares (app/layout.tsx adds og:url "./";
 * app/not-found.tsx uses these alone, so a missing page names no URL).
 */
export const SITE_OPEN_GRAPH = { type: "website", siteName: "Manci", locale: "en_US" } as const;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The site origin, e.g. "https://www.manci.io" (no trailing slash). */
export function siteUrl(value: string | undefined = process.env.NEXT_PUBLIC_SITE_URL): string {
  const raw = value?.trim();
  if (!raw) return DEFAULT_SITE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return DEFAULT_SITE_URL;
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
  if (!secure || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    return DEFAULT_SITE_URL;
  }
  return url.origin;
}

/**
 * An absolute URL on the site for a path that starts with "/". The home page
 * is the bare origin, as Next.js writes its canonical link, so the sitemap
 * and the page name the same URL.
 */
export function siteHref(path: string, origin: string = siteUrl()): string {
  const url = new URL(path, `${origin}/`);
  return url.pathname === "/" && !url.search && !url.hash ? url.origin : url.href;
}
