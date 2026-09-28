import { NextResponse } from "next/server";
import { requireModule } from "@/lib/server/feature-gate";
import { requireAdmin } from "@/lib/server/admin-gate";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { bindDistributionPlan } from "@/lib/server/distribution-plans";
import { boundedRequest } from "@/lib/server/bounded-request";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    // Pilot scope (lib/features.ts): an entry route of the distributions module.
    requireModule("distributions");
    const { wallet, params } = await verifySigned(await boundedRequest(request, 65_536), "distribution-plans.bind"); await requireAdmin(wallet);
    return NextResponse.json({ ok: true, data: await bindDistributionPlan(params.plan_id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return siwsErrorResponse(error); }
}
