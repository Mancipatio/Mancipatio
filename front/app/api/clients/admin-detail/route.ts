// POST /api/clients/admin-detail — admin read of one client's full record:
// the client row, internal notes, KYC requirements and document metadata.
// Signed + requireAdmin. clients / client_notes / client_documents /
// kyc_requirements have no anon SELECT (PII + internal notes), so the admin
// client-detail page loads everything through this one route (one signature).

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

const CLIENT_COLUMNS =
  "id,created_at,updated_at,network,type,types,tier,tags,source,email," +
  "display_name,company_name,jurisdiction,kyc_status,kyc_provider," +
  "kyc_provider_ref,kyc_verified_at,kyc_expires_at,onboarding_status,wallet," +
  "issuer_pda,suspended_at,notes_count,last_activity_at,tos_accepted_at,tos_version";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "clients.adminDetail");
    await requireAdmin(wallet);

    const id = typeof params.id === "string" ? params.id : "";
    if (!id) throw new SiwsError(400, "id is required");

    const sb = getSupabaseAdmin();
    const { data: client, error: clientErr } = await sb
      .from("clients")
      .select(CLIENT_COLUMNS)
      .eq("id", id)
      .eq("network", detectNetwork())
      .maybeSingle();
    if (clientErr) throw new SiwsError(500, "Client lookup failed");
    if (!client) throw new SiwsError(404, "Client not found");

    const [notesRes, reqRes, docsRes] = await Promise.all([
      sb
        .from("client_notes")
        .select("*")
        .eq("client_id", id)
        .order("created_at", { ascending: false }),
      sb
        .from("kyc_requirements")
        .select("*")
        .eq("client_id", id)
        .order("requested_at", { ascending: false }),
      sb
        .from("client_documents")
        .select("*")
        .eq("client_id", id)
        .order("created_at", { ascending: false }),
    ]);
    if (notesRes.error || reqRes.error || docsRes.error) {
      throw new SiwsError(500, "Could not load the client record");
    }

    return NextResponse.json({
      ok: true,
      data: {
        client,
        notes: notesRes.data ?? [],
        requirements: reqRes.data ?? [],
        documents: docsRes.data ?? [],
      },
    });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
