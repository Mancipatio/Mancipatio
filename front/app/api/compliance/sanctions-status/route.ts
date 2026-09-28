// POST /api/compliance/sanctions-status — the state of every sanctions
// screening list (8.5, lib/server/sanctions.ts): publication loaded, last
// refresh and its outcome, address count, whether the routes enforce it.
// Signed or wallet session ("compliance.sanctionsStatus" is a session read)
// + requireAdmin. The hits themselves are compliance alerts
// (/api/compliance/list, source ofac-sdn).
//
// Client wrapper: getSanctionsStatus() in lib/compliance.ts.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { sanctionsStatus, screeningFailsClosed, SANCTIONS_MAX_LIST_AGE_MS } from "@/lib/server/sanctions";

export async function POST(request: Request) {
  try {
    const { wallet } = await verifySigned(request, "compliance.sanctionsStatus");
    await requireAdmin(wallet);
    const network = detectNetwork();
    const lists = await sanctionsStatus(getSupabaseAdmin());
    return NextResponse.json(
      {
        ok: true,
        data: {
          network,
          enforcement: screeningFailsClosed(network) ? "fail-closed" : "warn",
          maxAgeHours: SANCTIONS_MAX_LIST_AGE_MS / 3_600_000,
          lists,
        },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
