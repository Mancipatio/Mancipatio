// POST /api/delivery/list-mine — holder reads their own delivery requests.
// Signed (SIWS): delivery_requests has NO anon SELECT (rows carry the holder's
// physical delivery address + contact — PII), so even reads are signed and the
// query is bound to the VERIFIED signer — the caller can never enumerate other
// holders' requests. Mirror of /api/conversion/list-mine.
//
// The signer's own KYC verdict rides along in the same round-trip, computed by
// the SAME resolver the create route's gate uses (lib/server/kyc-gate.ts), so
// the page's "+ Request delivery" is enabled exactly when /api/delivery/create
// would accept, and `message` is the 403 text it would answer with. A failed
// lookup answers `kyc: null` ("could not check"); the requests still load.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { kycGateMessage, lookupClientKyc, type ClientKycLookup } from "@/lib/server/kyc-gate";

/** The context the create route names in its gate message (kept equal by tests/holder-conversion-list-mine.test.ts). */
const GATE_CONTEXT = "requesting delivery";

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

    let kyc: ClientKycLookup | null = null;
    try {
      kyc = await lookupClientKyc(sb, wallet);
    } catch (err) {
      console.error("[api/delivery/list-mine] KYC lookup failed:", err instanceof Error ? err.message : err);
    }

    return NextResponse.json({
      ok: true,
      data: {
        requests: data ?? [],
        kyc: kyc && {
          eligible: kyc.eligible,
          status: kyc.kycStatus,
          expired: kyc.expired,
          message: kycGateMessage(kyc, GATE_CONTEXT),
        },
        // The delivery page reads this field (eligible = "verified"): the
        // gate's EFFECTIVE status, so "verified" always means the create route
        // would accept — an account-verified holder included.
        kyc_status: kyc === null ? null : kyc.eligible ? "verified" : kyc.expired ? "expired" : kyc.kycStatus,
      },
    });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
