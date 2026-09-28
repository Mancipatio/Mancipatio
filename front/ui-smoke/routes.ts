// Every page of the app router (app/**/page.tsx), as the smoke visits it.
//
// The list is read from the file system, so a new page is smoke-tested
// without touching this file. A new DYNAMIC page needs a concrete path in
// DYNAMIC_PATHS below: routes.spec.ts fails until it has one.
import { readdirSync } from "node:fs";
import path from "node:path";
import { SMOKE_ABSENT_ADDRESS, SMOKE_SALE } from "./support/chain-fixtures";

export type RouteKind = "public" | "app" | "admin";

export type SmokeRoute = {
  /** The page file, relative to front/. */
  file: string;
  /** The route as the router spells it, route groups removed: /markets/[slug]. */
  pattern: string;
  /** A concrete path to open. */
  path: string;
  kind: RouteKind;
};

const FRONT = path.resolve(__dirname, "..");
const APP = path.join(FRONT, "app");

/** Concrete paths for the dynamic routes: a slug the page pre-renders, or an
 *  id/address the mock chain does not hold (the page's "not found" state). */
export const DYNAMIC_PATHS: Record<string, string> = {
  "/markets/[slug]": "/markets/equity",
  "/markets/types/[slug]": "/markets/types/equity",
  "/solutions/[slug]": "/solutions/tokenization",
  "/admin/assets/[id]": `/admin/assets/${SMOKE_ABSENT_ADDRESS}`,
  "/admin/clients/[id]": "/admin/clients/00000000-0000-4000-8000-000000000000",
  "/admin/payouts/[id]": `/admin/payouts/${SMOKE_ABSENT_ADDRESS}`,
  "/issuer/assets/[id]": `/issuer/assets/${SMOKE_ABSENT_ADDRESS}`,
  "/issuer/vesting/[id]": `/issuer/vesting/${SMOKE_ABSENT_ADDRESS}`,
  "/marketplace/assets/[id]": `/marketplace/assets/${SMOKE_ABSENT_ADDRESS}`,
  "/marketplace/issuers/[id]": `/marketplace/issuers/${SMOKE_ABSENT_ADDRESS}`,
  "/marketplace/launchpad/[sale]": `/marketplace/launchpad/${SMOKE_SALE.absentSale}`,
  "/marketplace/otc/[offer]": `/marketplace/otc/${SMOKE_ABSENT_ADDRESS}`,
  "/onboarding/[id]": "/onboarding/00000000-0000-4000-8000-000000000000",
};

const APP_PREFIXES = ["/marketplace", "/portfolio", "/issuer", "/account", "/verify", "/onboarding", "/apply"];

function kindOf(pattern: string): RouteKind {
  if (pattern === "/admin" || pattern.startsWith("/admin/")) return "admin";
  if (APP_PREFIXES.some((prefix) => pattern === prefix || pattern.startsWith(`${prefix}/`))) return "app";
  return "public";
}

function pageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Private folders (_x) and the API are not pages.
      if (entry.name.startsWith("_") || (dir === APP && entry.name === "api")) return [];
      return pageFiles(full);
    }
    return entry.name === "page.tsx" ? [full] : [];
  });
}

/** The route pattern of a page file: route groups "(x)" dropped. */
export function patternOf(file: string): string {
  const segments = path
    .relative(APP, path.dirname(file))
    .split(path.sep)
    .filter((segment) => segment !== "" && !/^\(.+\)$/.test(segment));
  return `/${segments.join("/")}`;
}

/** Every page, sorted by pattern. Throws on a dynamic page without a path. */
export function smokeRoutes(): SmokeRoute[] {
  return pageFiles(APP)
    .map((full) => {
      const pattern = patternOf(full);
      const dynamic = pattern.includes("[");
      const concrete = dynamic ? DYNAMIC_PATHS[pattern] : pattern;
      if (!concrete) {
        throw new Error(`ui-smoke: ${pattern} is a dynamic page without a path in DYNAMIC_PATHS (ui-smoke/routes.ts)`);
      }
      return { file: path.relative(FRONT, full), pattern, path: concrete, kind: kindOf(pattern) };
    })
    .sort((a, b) => a.pattern.localeCompare(b.pattern));
}
