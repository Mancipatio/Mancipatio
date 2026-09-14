import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/admin-gate";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { boundedRequest } from "@/lib/server/bounded-request";
import { prepareDistributionPlan } from "@/lib/server/distribution-plans";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    const copy = await boundedRequest(request, 2_000_000);
    const { wallet, params } = await verifySigned(copy.clone(), "distribution-plans.prepare"); await requireAdmin(wallet);
    const body = await copy.json();
    return NextResponse.json({ ok: true, data: await prepareDistributionPlan(wallet, params, body.plan_entries) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return siwsErrorResponse(error); }
}
