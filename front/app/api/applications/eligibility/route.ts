// POST /api/applications/eligibility — the signer's OWN apply verdict, for
// the /apply gate.
//
// A session read bound to the signer ("applications.eligibility" is in
// SESSION_READ_ACTIONS, lib/siws-session.ts): the wallet session the /apply
// page already holds for applications.mine answers it, so rendering the gate
// costs no extra wallet prompt. The verdict is the caller's own and never
// another wallet's — the former unsigned route took any `wallet` in the body
// and answered with that wallet's KYC/KYB outcome (verified, rejected,
// suspended), which links a pseudonymous wallet to a compliance outcome for
// anyone who asks. A body wallet is ignored now. The shape is unchanged:
// { hasClient, kycStatus, eligible, kybStatus, individualKycStatus,
// applicantKind } — no row id, no PII — and the client still fails OPEN when
// the read fails (null = unknown).
//
// UX only: the authoritative gate is requireVerifiedApplicant in the signed
// submit/resubmit routes.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { lookupApplicant } from "../_lib";

export async function POST(request: Request) {
  try {
    const { wallet } = await verifySigned(request, "applications.eligibility");
    // Approved KYB (company) or live KYC (individual — Manci opens the company).
    const verdict = await lookupApplicant(getSupabaseAdmin(), wallet);
    return NextResponse.json(
      { ok: true, data: verdict },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
