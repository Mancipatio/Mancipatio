import { NextResponse } from "next/server";
import { requireModule } from "@/lib/server/feature-gate";
import { requireAdmin } from "@/lib/server/admin-gate";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { boundedRequest } from "@/lib/server/bounded-request";
import { prepareDistributionPlan } from "@/lib/server/distribution-plans";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    // Pilot scope (lib/features.ts): an entry route of the distributions module.
    requireModule("distributions");
    const copy = await boundedRequest(request, 2_000_000);
    const { wallet, params } = await verifySigned(copy.clone(), "distribution-plans.prepare"); await requireAdmin(wallet);
    const body = await copy.json();
    return NextResponse.json({ ok: true, data: await prepareDistributionPlan(wallet, params, body.plan_entries) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return siwsErrorResponse(error); }
}
