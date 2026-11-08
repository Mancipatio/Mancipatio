// GET /api/cap-table/public?asset=<asset PDA> — the public "Supply and
// conversions" figures of an asset (components/supply-conversions-panel.tsx
// on /marketplace/assets/[id]): per share class with a mint, the class cap
// in units, issued, outstanding, in conversion, the conversions recorded in
// the company register (date, units, percent, registry, decision document
// SHA-256, realize transaction) and those realized on chain whose register
// entry is still pending (units, realize transaction). The share of the
// company one unit is comes only from a published asset profile's tokenize
// figures that match the class; without it the figures are units only.
//
// Open and unsigned, like the asset page itself: read-only browsing stays
// open in KYC-only mode. No personal data and no case number: the database
// read selects only the non-personal columns of recorded register entries,
// the status, vault, units and realize signature of conversion requests,
// and the tokenize object of a published profile, of which only the derived
// share of one unit is returned (lib/server/cap-table.ts readPublicSupply).
// Scoped to this deployment's network. The one parameter is validated as an
// address before any read, so the CDN key space is bounded by real
// addresses; the CDN may share an answer for a minute, browsers never store
// it. A chain or database failure answers 503 (never cached), an address
// that is not an asset 404.
//
// Body: { ok: true, data: PublicSupply }.

import { NextResponse } from "next/server";
import { siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { assetPdaParam, readPublicSupply } from "@/lib/server/cap-table";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const SHARED_CACHE = "public, max-age=0, s-maxage=60, stale-while-revalidate=300";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const keys = [...url.searchParams.keys()];
    if (keys.length !== 1 || keys[0] !== "asset") {
      throw new SiwsError(400, "Exactly one asset parameter is accepted");
    }
    const supply = await readPublicSupply(assetPdaParam(url.searchParams.get("asset"), "asset"));
    return NextResponse.json({ ok: true, data: supply }, { headers: { "Cache-Control": SHARED_CACHE } });
  } catch (err) {
    const response = siwsErrorResponse(err);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
