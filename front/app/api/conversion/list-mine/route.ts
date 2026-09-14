// POST /api/conversion/list-mine — holder reads their own conversion
// requests. Signed (SIWS): conversion_requests has NO anon SELECT (rows
// carry holder contact details — PII), so even reads are signed and the
// query is bound to the VERIFIED signer — the caller can never enumerate
// other holders' requests.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

export async function POST(request: Request) {
  try {
    const { wallet } = await verifySigned(request, "conversion.listMine");

    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("conversion_requests")
      .select("*")
      .eq("holder_wallet", wallet)
      .eq("network", detectNetwork())
      .order("created_at", { ascending: false });
    if (error) {
      console.error("[api/conversion/list-mine] query failed:", error.message);
      throw new SiwsError(500, "Could not load your conversion requests");
    }

    // Fold in the signer's own KYC status so the page can gate the "request"
    // button in the SAME signed round-trip (no second signature). oldest match
    // wins (mirrors findClientByWallet).
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
