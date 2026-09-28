// POST /api/compliance/sanctions-refresh — an Admin runs the daily OFAC SDN
// refresh now (lib/server/sanctions-refresh.ts), e.g. after a failed night
// run or right after the list was republished. Signed + requireAdmin; the
// same job the scheduler calls (/api/internal/sanctions). Codes and counts
// only.
//
// Client wrapper: refreshSanctionsList() in lib/compliance.ts.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { runSanctionsRefresh } from "@/lib/server/sanctions-refresh";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const { wallet } = await verifySigned(request, "compliance.sanctionsRefresh");
    await requireAdmin(wallet);
    const data = await runSanctionsRefresh();
    return NextResponse.json({ ok: true, data }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
