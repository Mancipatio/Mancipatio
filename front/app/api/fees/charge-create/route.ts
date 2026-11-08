// POST /api/fees/charge-create — book one fee charge (migration 0089):
// priced on the server by quoteFee from the PUBLISHED price of its kind, for
// a conversion request, an application or another reference of this
// network. Signed ("fees.chargeCreate") + requireAdmin. Nothing is collected
// here: the charge is "due" until an admin records the invoice
// (fees/charge-update), and collection is by invoice, off-chain. A
// conversion charge is billed to the requesting holder's client, never a
// payer named in the request. Refused (409) while no price of the kind is
// published or in effect, and for a reference that already has an open
// charge of the kind. Audited (fee_charge_create).
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { auditFeeWrite, createFeeCharge, quoteSummary } from "@/lib/server/fee-schedule";

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(request, "fees.chargeCreate");
    await requireAdmin(wallet);
    const { charge, quote, schedule } = await createFeeCharge(params, wallet);
    await auditFeeWrite({
      event: "fee_charge_create",
      wallet,
      via,
      reason: `Fee charge booked: ${schedule.public_label}, ${quoteSummary(quote)} for ${charge.ref_type} ${charge.ref_id}`,
      target: charge.id,
      metadata: {
        charge_id: charge.id, kind: charge.kind, schedule_id: charge.schedule_id, ref_type: charge.ref_type, ref_id: charge.ref_id,
        payer_client_id: charge.payer_client_id, issuer_pda: charge.issuer_pda, base_amount_eur: charge.base_amount_eur,
        quantity: charge.quantity, amount_eur: charge.amount_eur, basis: quote.basis,
      },
    });
    return NextResponse.json({ ok: true, data: { charge, quote } }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
