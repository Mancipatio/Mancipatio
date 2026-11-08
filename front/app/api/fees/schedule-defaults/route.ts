// POST /api/fees/schedule-defaults — "Load suggested defaults": the owner's
// suggested prices (lib/fees/schedule.ts SUGGESTED_FEE_DRAFTS) as DRAFTS,
// for the kinds that have no draft and no published price yet (migration
// 0089). Signed ("fees.scheduleDefaults") + requireAdmin. Nothing is
// published or charged: each draft still needs the Super Admin's publish.
// Audited (fee_schedule_defaults) when it created anything.
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { auditFeeWrite, createSuggestedDrafts } from "@/lib/server/fee-schedule";

export async function POST(request: Request) {
  try {
    const { wallet, via } = await verifySigned(request, "fees.scheduleDefaults");
    await requireAdmin(wallet);
    const result = await createSuggestedDrafts(wallet);
    if (result.created.length > 0) {
      await auditFeeWrite({
        event: "fee_schedule_defaults",
        wallet,
        via,
        reason: `Suggested fee drafts created: ${result.created.map((fee) => fee.kind).join(", ")}`,
        target: null,
        metadata: { created: result.created.map((fee) => ({ fee_id: fee.id, kind: fee.kind })), skipped: result.skipped },
      });
    }
    return NextResponse.json({ ok: true, data: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
