// POST /api/fees/schedule-list — admin read of the fee schedule (drafts,
// published and retired rows) and the latest charges of this network
// (migration 0089). Signed ("fees.scheduleList", a session read, so the
// /admin/fees page loads without a second prompt) + requireAdmin: drafts
// are unpublished business decisions, and charges name clients and amounts.
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { listFeeAdmin } from "@/lib/server/fee-schedule";

export async function POST(request: Request) {
  try {
    const { wallet } = await verifySigned(request, "fees.scheduleList");
    await requireAdmin(wallet);
    const data = await listFeeAdmin();
    return NextResponse.json({ ok: true, data }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
