// GET /api/fees/public — PUBLIC: the published fee schedule of this network
// (migration 0089), for the quote surfaces (components/fee-quote.tsx).
// Unsigned and ungated by design: a price list must be readable before
// sign-in and in KYC-only mode, like /pricing itself, which reads the same
// projection on the server. Only PUBLISHED rows, only the public projection
// (lib/fees/schedule.ts PUBLIC_FEE_COLUMNS): no drafts, no retired rows, no
// ids, no admin wallets, no charges. An empty list means nothing is
// published (or 0089 is not applied yet); a failure answers 503, never an
// empty list, so a quote surface cannot mistake an outage for "no fee".
import { NextResponse } from "next/server";
import { siwsErrorResponse } from "@/lib/server/siws";
import { loadPublishedFees } from "@/lib/server/fee-schedule";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const fees = await loadPublishedFees();
    return NextResponse.json({ ok: true, data: { fees } }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
