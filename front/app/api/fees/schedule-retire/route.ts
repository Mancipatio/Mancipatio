// POST /api/fees/schedule-retire — retire the published price of one kind
// (migration 0089): it leaves /pricing and the quote surfaces, and no new
// charge can be priced from it; charges already booked keep it. Signed
// ("fees.scheduleRetire") + requireSuperAdmin, like publishing. Compares the
// row's revision (expected_updated_at). Audited (fee_schedule_retire).
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { requireSuperAdmin } from "@/lib/server/admin-gate";
import { auditFeeWrite, retireFee } from "@/lib/server/fee-schedule";
import { describeFee } from "@/lib/fees/quote";

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(request, "fees.scheduleRetire");
    await requireSuperAdmin(wallet);
    const fee = await retireFee(params, wallet);
    await auditFeeWrite({
      event: "fee_schedule_retire",
      wallet,
      via,
      reason: `Fee retired: ${fee.public_label} (${describeFee(fee)})`,
      target: fee.id,
      metadata: { fee_id: fee.id, kind: fee.kind, payer: fee.payer },
    });
    return NextResponse.json({ ok: true, data: { fee } }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
