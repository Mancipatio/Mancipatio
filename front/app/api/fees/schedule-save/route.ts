// POST /api/fees/schedule-save — create or edit one DRAFT of the fee
// schedule (migration 0089). Signed ("fees.scheduleSave") + requireAdmin.
// A draft is private: it reaches /pricing and the quote surfaces only when
// the Super Admin publishes it (fees/schedule-publish). Network and author
// are stamped server-side; an edit names the revision it was made from
// (expected_updated_at), and a draft that changed, was published or was
// deleted meanwhile answers 409. Audited (fee_schedule_save).
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { auditFeeWrite, saveFeeDraft } from "@/lib/server/fee-schedule";
import { describeFee } from "@/lib/fees/quote";

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(request, "fees.scheduleSave");
    await requireAdmin(wallet);
    const created = params.id === undefined || params.id === null;
    const fee = await saveFeeDraft(params, wallet);
    await auditFeeWrite({
      event: "fee_schedule_save",
      wallet,
      via,
      reason: `Fee draft ${created ? "created" : "edited"}: ${fee.public_label} (${describeFee(fee)})`,
      target: fee.id,
      metadata: {
        op: created ? "create" : "edit", fee_id: fee.id, kind: fee.kind, payer: fee.payer,
        fixed_eur: fee.fixed_eur, rate_bps: fee.rate_bps, min_eur: fee.min_eur, max_eur: fee.max_eur,
        effective_from: fee.effective_from,
      },
    });
    return NextResponse.json({ ok: true, data: { fee } }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
