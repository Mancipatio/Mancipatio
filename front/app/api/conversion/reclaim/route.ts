import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { recordCustodyReturn } from "@/lib/server/custody-evidence";
import { notifyConversionStatus } from "@/lib/server/conversion-notifications";

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(
      request,
      "conversion.reclaim",
    );
    const id = typeof params.id === "string" ? params.id : "";
    if (!id || id.length > 64) throw new SiwsError(400, "id is required");
    const data = await recordCustodyReturn(
      "conversion_requests",
      id,
      wallet,
      params.outcome_tx,
    );
    // The holder's email, after the response and at most once per request.
    if (data.status === "returned") notifyConversionStatus(id, "returned");
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    return siwsErrorResponse(error);
  }
}
