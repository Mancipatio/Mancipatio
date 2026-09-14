// POST /api/clients/admin-list — admin read of the client directory.
// Signed + requireAdmin. clients has no anon SELECT (the row set is the full
// client directory: names, emails, KYC verdicts — PII), so the admin pages
// load it through this route. Mirror of /api/compliance/list.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

// Explicit column list — EXCLUDES onboarding_token (the magic-link bearer
// secret), which must never leave the server even for admins.
const CLIENT_COLUMNS =
  "id,created_at,updated_at,network,type,types,tier,tags,source,email," +
  "display_name,company_name,jurisdiction,kyc_status,kyc_provider," +
  "kyc_verified_at,kyc_expires_at,onboarding_status,wallet,issuer_pda," +
  "suspended_at,notes_count,last_activity_at,tos_accepted_at,tos_version";

export async function POST(request: Request) {
  try {
    const { wallet } = await verifySigned(request, "clients.adminList");
    await requireAdmin(wallet);

    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("clients")
      .select(CLIENT_COLUMNS)
      .eq("network", detectNetwork())
      .order("created_at", { ascending: false });
    if (error) {
      console.error("[api/clients/admin-list] query failed:", error.message);
      throw new SiwsError(500, "Could not load the client directory");
    }

    return NextResponse.json({ ok: true, data: { clients: data ?? [] } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
