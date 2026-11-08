// POST /api/fees/charge-update — move one fee charge forward (migration
// 0089): invoiced (with the invoice reference), paid, or waived (with a
// reason). Signed ("fees.chargeUpdate") + requireAdmin. The amount and the
// reference never change; the status only moves due -> invoiced -> paid, or
// due | invoiced -> waived (the database guard refuses anything else).
// Compares the charge's revision (expected_updated_at). Audited
// (fee_charge_update).
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { auditFeeWrite, updateFeeCharge } from "@/lib/server/fee-schedule";
import { formatEur } from "@/lib/fees/quote";

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(request, "fees.chargeUpdate");
    await requireAdmin(wallet);
    const { charge, update } = await updateFeeCharge(params, wallet);
    const detail = update.status === "invoiced" ? ` (invoice ${update.invoice_ref})`
      : update.status === "waived" ? `: ${update.waived_reason}` : "";
    await auditFeeWrite({
      event: "fee_charge_update",
      wallet,
      via,
      reason: `Fee charge of ${formatEur(charge.amount_eur)} marked ${update.status}${detail}`,
      target: charge.id,
      metadata: {
        charge_id: charge.id, kind: charge.kind, status: charge.status, amount_eur: charge.amount_eur,
        invoice_ref: charge.invoice_ref, waived_reason: charge.waived_reason,
      },
    });
    return NextResponse.json({ ok: true, data: { charge } }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
