// POST /api/passport/list — admin read of the KYC passport-request queue.
//
// Signed + requireAdminOrKycProvider (the registry authority decides these
// requests on-chain and must still see the queue after a platform-admin
// rotation, e2e §5). passport_requests rows deanonymize the KYC pipeline
// (wallet ↔ application ↔ self-declared jurisdiction + free-text applicant
// note + handling admin), so the anon SELECT policy is dropped in 0031 and
// the /admin/kyc queue reads through this route instead of the shipped anon
// key. Investors check their OWN open request via the minimal, unsigned
// /api/passport/status (id/status/created_at only).
//
// Client wrapper: listPassportRequests() in lib/passport.ts
// (action "passport.list").

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdminOrKycProvider } from "@/lib/server/kyc-provider-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";

export async function POST(request: Request) {
  try {
    const { wallet } = await verifySigned(request, "passport.list");
    await requireAdminOrKycProvider(wallet);

    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("passport_requests")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      console.error("[api/passport/list] query failed:", error.message);
      throw new SiwsError(500, "Could not load passport requests");
    }

    return NextResponse.json({ ok: true, data: { requests: data ?? [] } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
