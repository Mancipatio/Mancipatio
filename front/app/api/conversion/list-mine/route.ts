// POST /api/conversion/list-mine — holder reads their own conversion
// requests. Signed (SIWS): conversion_requests has NO anon SELECT (rows
// carry holder contact details — PII), so even reads are signed and the
// query is bound to the VERIFIED signer — the caller can never enumerate
// other holders' requests.
//
// The signer's own KYC verdict rides along in the same round-trip so the page
// can gate "+ Request conversion" without a second signature. It is computed
// by the SAME resolver the create route's gate uses (lib/server/kyc-gate.ts:
// the active network, the verdict's expiry, the account's dossier for a
// linked wallet, a terminal row ahead of an older verified one), so the
// button is enabled exactly when /api/conversion/create would accept, and
// `message` is the 403 text it would answer with. A failed lookup answers
// `kyc: null` ("could not check"); the requests still load.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { kycGateMessage, lookupClientKyc, type ClientKycLookup } from "@/lib/server/kyc-gate";

/** The context the create route names in its gate message (kept equal by tests/holder-conversion-list-mine.test.ts). */
const GATE_CONTEXT = "requesting a conversion";

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

    let kyc: ClientKycLookup | null = null;
    try {
      kyc = await lookupClientKyc(sb, wallet);
    } catch (err) {
      console.error("[api/conversion/list-mine] KYC lookup failed:", err instanceof Error ? err.message : err);
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
        // Older clients read this field: the gate's EFFECTIVE status, so a
        // "verified" here always means the create route would accept.
        kyc_status: kyc === null ? null : kyc.eligible ? "verified" : kyc.expired ? "expired" : kyc.kycStatus,
      },
    });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
