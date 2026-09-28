// Geoblocking by country (8.5; pravo-compliance-6, pravo-compliance-3).
// Which countries (and, where the edge reports it, regions) the platform
// does not serve is COUNSEL'S decision, recorded as configuration:
//
//   GEOBLOCK_COUNTRIES=KP,IR,CU,SY,UA-43,UA-40      (ISO 3166-1 alpha-2,
//                                                   or CC-REGION, ISO 3166-2)
//   GEOBLOCK_COUNTRIES=none                         (counsel: block nothing)
//
// A mainnet build refuses an unset or malformed list (next.config.ts
// assertBuildGeoblock): "no list" must be a written decision, never an
// omission. A code must be a real ISO 3166-1 alpha-2 country (lib/
// countries.ts), or a user-assigned one (AA, QM–QZ, XA–XZ, ZZ: the CI
// placeholder, and XK, which Vercel reports for Kosovo): "UK" or "EL" is
// well formed but blocks nothing (Vercel reports GB and GR), so it is
// refused with the right code. Enforcement (proxy.ts) reads Vercel's
// x-vercel-ip-country and x-vercel-ip-country-region headers, which the
// platform sets itself; on mainnet they are trusted only on Vercel's runtime
// (VERCEL=1), since behind any other proxy a client can send them:
//   - a transactional API route (GEOBLOCKED_API_ROUTES) from a listed
//     country answers 451; WITHOUT the country header on mainnet it answers
//     451 as well (fail closed: an unknown origin cannot be cleared);
//   - an app page (GEOBLOCKED_PAGE_PREFIXES) from a listed country shows
//     /not-available instead; a page without the header is served. The
//     portfolio is not blocked: it carries the exits of positions a holder
//     already has (cancel an offer, withdraw a listing, refund a failed
//     sale, claim, reclaim a custody deposit), and exits stay open, as for
//     the pause and the module switches; its entries are the API routes.
// Off mainnet an unset list blocks nothing and a missing header is allowed
// (local development and previews). IP geolocation is a first line, not a
// guarantee (VPNs): the Terms' eligibility clause and the wallet sanctions
// screen (lib/server/sanctions.ts) stay the other lines.
//
// Pure: next.config.ts loads it at build time by relative path, like
// lib/legal/*, so it imports only lib/countries.ts (import-free), by
// relative path.

import { COUNTRIES } from "./countries";

export const GEOBLOCK_ENV = "GEOBLOCK_COUNTRIES";
export const COUNTRY_HEADER = "x-vercel-ip-country";
export const REGION_HEADER = "x-vercel-ip-country-region";

export const GEOBLOCKED_MESSAGE =
  "Manci is not available in your country. Nothing was changed. If you believe this is a mistake, contact support.";

export type GeoblockConfig =
  | { ok: true; set: false }
  | { ok: true; set: true; none: boolean; countries: ReadonlySet<string>; regions: ReadonlySet<string> }
  | { ok: false; error: string };

const ISO_ALPHA2: ReadonlySet<string> = new Set(COUNTRIES.map((c) => c.alpha2));

/** ISO 3166-1 user-assigned alpha-2 codes (AA, QM–QZ, XA–XZ, ZZ): no real country's, yet valid. */
export function isUserAssignedAlpha2(code: string): boolean {
  return code === "AA" || code === "ZZ" || /^Q[M-Z]$/.test(code) || /^X[A-Z]$/.test(code);
}

/** Common non-ISO spellings of a country, and the code Vercel reports instead. */
export const NON_ISO_COUNTRY_CODES: Readonly<Record<string, string>> = { UK: "GB", EL: "GR" };

/** A reason `code` (two letters) is not a country the edge can report, or null. */
function countryCodeProblem(code: string, token: string): string | null {
  if (ISO_ALPHA2.has(code) || isUserAssignedAlpha2(code)) return null;
  const hint = NON_ISO_COUNTRY_CODES[code];
  return hint
    ? `"${token}" is not an ISO 3166-1 country code (did you mean ${hint}?)`
    : `"${token}" is not an ISO 3166-1 country code`;
}

/** Parses GEOBLOCK_COUNTRIES: unset, "none", or a comma/space list of CC and CC-REGION codes. */
export function parseGeoblockList(value: string | undefined): GeoblockConfig {
  const raw = value?.trim() ?? "";
  if (!raw) return { ok: true, set: false };
  if (raw.toLowerCase() === "none") return { ok: true, set: true, none: true, countries: new Set(), regions: new Set() };
  const countries = new Set<string>();
  const regions = new Set<string>();
  for (const token of raw.split(/[\s,]+/).filter(Boolean)) {
    const code = token.toUpperCase();
    if (/^[A-Z]{2}$/.test(code)) {
      const problem = countryCodeProblem(code, token);
      if (problem) return { ok: false, error: problem };
      countries.add(code);
    } else if (/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(code)) {
      const problem = countryCodeProblem(code.slice(0, 2), token);
      if (problem) return { ok: false, error: problem };
      regions.add(code);
    } else {
      return { ok: false, error: `"${token}" is not an ISO 3166 country (CC) or region (CC-REGION) code` };
    }
  }
  return { ok: true, set: true, none: false, countries, regions };
}

/**
 * Whether the edge's country headers can be believed on `network`: always
 * off mainnet (development, previews), and on mainnet only on Vercel's
 * runtime, which sets them itself (VERCEL=1). Elsewhere a client can send
 * them, so a mainnet request there counts as having no country header.
 */
export function trustsCountryHeaders(network: string, env: Record<string, string | undefined>): boolean {
  return network !== "mainnet" || env.VERCEL === "1";
}

export type GeoblockDecision = "allow" | "blocked" | "unknown";

/**
 * allow, blocked (a listed country or region), or unknown (no country
 * header, or no usable list, where the route must fail closed).
 */
export function geoblockDecision(input: {
  config: GeoblockConfig;
  country: string | null;
  region: string | null;
  network: string;
  kind: "api" | "page";
}): GeoblockDecision {
  const { config, network, kind } = input;
  const mainnet = network === "mainnet";
  // A mainnet deployment without a valid list (the build guard prevents it)
  // cannot clear a transaction.
  if (!config.ok || !config.set) return mainnet && kind === "api" ? "unknown" : "allow";
  const country = input.country?.trim().toUpperCase() ?? "";
  if (!/^[A-Z]{2}$/.test(country)) return mainnet && kind === "api" ? "unknown" : "allow";
  if (config.none) return "allow";
  if (config.countries.has(country)) return "blocked";
  const region = input.region?.trim().toUpperCase() ?? "";
  if (region && config.regions.has(`${country}-${region}`)) return "blocked";
  return "allow";
}

/**
 * The transactional API routes: every entry into a purchase, a trade, a
 * listing, a passport, a verification or a raise. Exits (cancels, refunds,
 * withdrawals, claims) and reads are not listed; the operator's admin and
 * internal routes neither. Nor is the purchase record
 * (/api/launchpad/record-purchase): it records a buy that already landed
 * on-chain, and the record must match the chain.
 */
export const GEOBLOCKED_API_ROUTES: readonly string[] = [
  "/api/launchpad/commit",
  "/api/compliance/screen-wallet",
  "/api/otc/create",
  "/api/resell/create",
  "/api/passport/submit",
  "/api/verification/submit",
  "/api/applications/submit",
  "/api/applications/resubmit",
  "/api/conversion/create",
  "/api/delivery/create",
  "/api/vesting-series/create",
  "/api/clients/accept-tos",
  "/api/tos/accept",
];

/**
 * The app pages a listed country does not get (the marketing site stays
 * readable). The portfolio is not listed (its exits stay open; see the
 * header), except its voting page, which is only an entry.
 */
export const GEOBLOCKED_PAGE_PREFIXES: readonly string[] = [
  "/marketplace",
  "/portfolio/governance",
  "/issuer",
  "/verify",
  "/onboarding",
  "/apply",
];

/** Where a blocked page request is shown instead. */
export const NOT_AVAILABLE_PATH = "/not-available";

export function geoblockKind(path: string): "api" | "page" | null {
  if (GEOBLOCKED_API_ROUTES.includes(path.replace(/\/+$/, ""))) return "api";
  if (GEOBLOCKED_PAGE_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return "page";
  return null;
}
