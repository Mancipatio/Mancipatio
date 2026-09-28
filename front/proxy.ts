// Next.js Proxy (formerly Middleware): geoblocking by country (8.5,
// lib/geoblock.ts). It runs only on the transactional API routes and the app
// pages a listed country does not get; everything else passes untouched.
//   - API: 451 JSON { ok: false, error } for a listed country, and on
//     mainnet for a request without Vercel's country header (fail closed).
//   - Pages: the /not-available page is shown in place (rewrite); a page
//     without the header is served.
// On mainnet the headers count only on Vercel's runtime (VERCEL=1), which
// sets them itself; anywhere else a client could send its own
// `x-vercel-ip-country: DE`, so there the request is treated as having none.
import { NextResponse, type NextRequest } from "next/server";
import {
  COUNTRY_HEADER,
  GEOBLOCK_ENV,
  GEOBLOCKED_MESSAGE,
  NOT_AVAILABLE_PATH,
  REGION_HEADER,
  geoblockDecision,
  geoblockKind,
  parseGeoblockList,
  trustsCountryHeaders,
} from "@/lib/geoblock";
import { detectNetwork } from "@/lib/network";

export function proxy(request: NextRequest) {
  const kind = geoblockKind(request.nextUrl.pathname);
  if (!kind) return NextResponse.next();
  const network = detectNetwork();
  const trusted = trustsCountryHeaders(network, { VERCEL: process.env.VERCEL });
  const decision = geoblockDecision({
    config: parseGeoblockList(process.env[GEOBLOCK_ENV]),
    country: trusted ? request.headers.get(COUNTRY_HEADER) : null,
    region: trusted ? request.headers.get(REGION_HEADER) : null,
    network,
    kind,
  });
  if (decision === "allow") return NextResponse.next();
  if (kind === "api") {
    return NextResponse.json(
      { ok: false, error: GEOBLOCKED_MESSAGE, code: decision === "blocked" ? "GEOBLOCKED" : "COUNTRY_UNKNOWN" },
      { status: 451, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  const url = request.nextUrl.clone();
  url.pathname = NOT_AVAILABLE_PATH;
  url.search = "";
  return NextResponse.rewrite(url, { headers: { "Cache-Control": "private, no-store" } });
}

// Literal matchers (Next reads them at build time); geoblockKind() decides.
export const config = {
  matcher: [
    "/api/launchpad/commit",
    "/api/compliance/screen-wallet",
    "/api/otc/create",
    "/api/resell/create",
    "/api/passport/submit",
    "/api/verification/submit",
    "/api/applications/:path*",
    "/api/conversion/create",
    "/api/delivery/create",
    "/api/vesting-series/create",
    "/api/clients/accept-tos",
    "/api/tos/accept",
    "/marketplace/:path*",
    "/portfolio/governance/:path*",
    "/issuer/:path*",
    "/verify",
    "/onboarding/:path*",
    "/apply",
  ],
};
