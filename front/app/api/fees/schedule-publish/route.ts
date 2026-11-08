// POST /api/fees/schedule-publish — publish one draft of the fee schedule
// (migration 0089): from this moment it is the price on /pricing and in the
// quote surfaces, and charges of its kind are priced from it once it is in
// effect. Signed ("fees.schedulePublish") + requireSuperAdmin: a public
// price is a business and legal decision of the owner (ops/env-vars.md
// "Fee schedule"), so a second Admin key prepares drafts but cannot publish,
// as only the Super Admin writes the EUR rates (admin-config/fx-rates).
// publish_fee_schedule retires the price in force for the same kind in the
// same transaction and compares the draft's revision. Audited
// (fee_schedule_publish) with the price it replaced.
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { requireSuperAdmin } from "@/lib/server/admin-gate";
import { auditFeeWrite, publishFee } from "@/lib/server/fee-schedule";
import { describeFee } from "@/lib/fees/quote";

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(request, "fees.schedulePublish");
    await requireSuperAdmin(wallet);
    const { published, replaced } = await publishFee(params, wallet);
    await auditFeeWrite({
      event: "fee_schedule_publish",
      wallet,
      via,
      reason: `Fee published: ${published.public_label} (${describeFee(published)}, paid by the ${published.payer})` +
        (replaced ? `; replaces ${describeFee(replaced)}` : ""),
      target: published.id,
      metadata: {
        fee_id: published.id, kind: published.kind, payer: published.payer,
        fixed_eur: published.fixed_eur, rate_bps: published.rate_bps, min_eur: published.min_eur, max_eur: published.max_eur,
        public_label: published.public_label, public_note: published.public_note,
        effective_from: published.effective_from, replaced_fee_id: replaced?.id ?? null,
      },
    });
    return NextResponse.json({ ok: true, data: { fee: published, replaced } }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
