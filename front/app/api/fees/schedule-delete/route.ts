// POST /api/fees/schedule-delete — delete one unchanged DRAFT of the fee
// schedule (migration 0089). Signed ("fees.scheduleDelete") + requireAdmin.
// Published and retired rows are the price history and are never deleted
// (the database refuses it too). Audited (fee_schedule_delete).
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { auditFeeWrite, deleteFeeDraft } from "@/lib/server/fee-schedule";

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(request, "fees.scheduleDelete");
    await requireAdmin(wallet);
    const deleted = await deleteFeeDraft(params);
    await auditFeeWrite({
      event: "fee_schedule_delete",
      wallet,
      via,
      reason: `Fee draft deleted (${deleted.kind})`,
      target: deleted.id,
      metadata: { fee_id: deleted.id, kind: deleted.kind },
    });
    return NextResponse.json({ ok: true, data: deleted }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
