import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { recordCustodyReturn } from "@/lib/server/custody-evidence";

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "delivery.reclaim");
    const id = typeof params.id === "string" ? params.id : "";
    if (!id || id.length > 64) throw new SiwsError(400, "id is required");
    const data = await recordCustodyReturn(
      "delivery_requests",
      id,
      wallet,
      params.outcome_tx,
    );
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    return siwsErrorResponse(error);
  }
}
