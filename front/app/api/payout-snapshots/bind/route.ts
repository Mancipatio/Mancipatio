import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/admin-gate";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { bindOriginalPayoutSnapshot } from "@/lib/server/payout-snapshots";
export const maxDuration = 30;
export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "payout-snapshots.bind");
    await requireAdmin(wallet);
    return NextResponse.json({ ok: true, data: await bindOriginalPayoutSnapshot(params.snapshot_id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return siwsErrorResponse(error); }
}
