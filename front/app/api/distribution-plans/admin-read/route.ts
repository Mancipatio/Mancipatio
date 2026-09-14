import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/admin-gate";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { readDistributionPlan, listDistributionPlans } from "@/lib/server/distribution-plans";
import { boundedRequest } from "@/lib/server/bounded-request";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(await boundedRequest(request, 65_536), "distribution-plans.adminRead"); await requireAdmin(wallet);
    const data = params.plan_id === undefined ? await listDistributionPlans(params) : await readDistributionPlan(params.plan_id);
    return NextResponse.json({ ok: true, data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return siwsErrorResponse(error); }
}
