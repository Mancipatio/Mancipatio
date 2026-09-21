// POST /api/clients/kyb-decision — compliance approves or rejects a company
// verification (KYB) submitted from /verify. Signed + requireAdmin. The KYB
// decision is separate from the dossier's individual KYC status and is what
// the /apply gate (requireVerifiedCompany) checks.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { assertUuid, fetchClientOr404, insertNote, oneOf, optString } from "../_helpers";

const DECISIONS = ["verified", "rejected", "pending"] as const;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "clients.kybDecision");
    await requireAdmin(wallet);
    const clientId = assertUuid(params.client_id, "client_id");
    const decision = oneOf(params.decision, DECISIONS, "decision");
    const note = optString(params, "note", 1000);

    const sb = getSupabaseAdmin();
    await fetchClientOr404(sb, clientId);
    const reviewed = decision === "pending"
      ? { reviewed_at: null, reviewed_by: null }
      : { reviewed_at: new Date().toISOString(), reviewed_by: wallet };
    const { data, error } = await sb.from("client_verification_details")
      .update({ status: decision, ...reviewed, review_note: note ?? null })
      .eq("client_id", clientId).eq("kind", "kyb").select("status");
    if (error) throw new SiwsError(500, "Could not save the KYB decision");
    if (!data || data.length === 0) throw new SiwsError(404, "This client has not submitted company (KYB) details");

    await insertNote(sb, clientId, wallet,
      `Company verification (KYB) ${decision === "verified" ? "approved" : decision === "rejected" ? "rejected" : "reopened for review"}${note ? `: ${note}` : "."}`,
      "kyc-event");
    return NextResponse.json({ ok: true, data: { status: decision } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
