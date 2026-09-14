// POST /api/delivery/list-mine — holder reads their own delivery requests.
// Signed (SIWS): delivery_requests has NO anon SELECT (rows carry the holder's
// physical delivery address + contact — PII), so even reads are signed and the
// query is bound to the VERIFIED signer — the caller can never enumerate other
// holders' requests. Mirror of /api/conversion/list-mine.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

export async function POST(request: Request) {
  try {
    const { wallet } = await verifySigned(request, "delivery.listMine");

    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("delivery_requests")
      .select("*")
      .eq("holder_wallet", wallet)
      .eq("network", detectNetwork())
      .order("created_at", { ascending: false });
    if (error) {
      console.error("[api/delivery/list-mine] query failed:", error.message);
      throw new SiwsError(500, "Could not load your delivery requests");
    }

    // Fold in the signer's own KYC status so the page can gate the "request"
    // button in the SAME signed round-trip (no second signature just to read
    // the client row). oldest match wins (mirrors findClientByWallet).
    const { data: client } = await sb
      .from("clients")
      .select("kyc_status")
      .eq("wallet", wallet)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    return NextResponse.json({
      ok: true,
      data: { requests: data ?? [], kyc_status: client?.kyc_status ?? null },
    });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
