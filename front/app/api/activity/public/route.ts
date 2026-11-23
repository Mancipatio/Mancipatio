// GET /api/activity/public — the overview's activity feed
// (components/activity-feed.tsx): the latest conversions entered in a company
// register and the latest public updates issuers published, newest first, at
// most ACTIVITY_LIMIT (lib/activity.ts).
//
// Open and unsigned, like the asset pages that already show the same facts
// one asset at a time (/api/cap-table/public, /api/issuer-updates/public):
// read-only browsing stays open in KYC-only mode. No personal data: the
// database read selects only an entry's asset, units, stake, registry and
// date, and an update's asset, kind and publication time
// (lib/server/activity.ts). Never a wallet, a holder, a case number or an
// issuer's text. Archived assets and issuers are left out. Scoped to this
// deployment's network.
//
// The route takes no parameter (any is refused), so the CDN holds one answer,
// for a minute; browsers never store it. A database failure answers 503,
// never cached.
//
// Body: { ok: true, data: { items: PublicActivity[] } }.

import { NextResponse } from "next/server";
import { siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { readPublicActivity } from "@/lib/server/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const SHARED_CACHE = "public, max-age=0, s-maxage=60, stale-while-revalidate=300";

export async function GET(request: Request) {
  try {
    if ([...new URL(request.url).searchParams.keys()].length > 0) {
      throw new SiwsError(400, "This route takes no parameters");
    }
    const items = await readPublicActivity();
    return NextResponse.json({ ok: true, data: { items } }, { headers: { "Cache-Control": SHARED_CACHE } });
  } catch (err) {
    const response = siwsErrorResponse(err);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
