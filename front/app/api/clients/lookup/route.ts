// POST /api/clients/lookup — admin checks whether a given wallet belongs to an
// onboarded, KYC-verified client (e.g. before routing a mint to it).
// Signed + requireAdmin: returns only the minimal onboarding facts for ONE
// queried wallet (no bulk enumeration — the caller passes a specific wallet and
// must be an admin), so this is not a directory-dump surface.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Same safe projection as the directory (no onboarding_token) — the caller is
// already an admin, so returning the full row is no more than they can read via
// the directory; keeping the shape identical lets the client type it as ClientRow.
const CLIENT_COLUMNS =
  "id,created_at,updated_at,network,type,types,tier,tags,source,email," +
  "display_name,company_name,jurisdiction,kyc_status,kyc_provider," +
  "kyc_verified_at,kyc_expires_at,onboarding_status,wallet,issuer_pda," +
  "suspended_at,notes_count,last_activity_at,tos_accepted_at,tos_version";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "clients.lookup");
    await requireAdmin(wallet);

    const target = typeof params.wallet === "string" ? params.wallet.trim() : "";
    if (!BASE58_RE.test(target)) {
      throw new SiwsError(400, "wallet is not a valid address");
    }

    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("clients")
      .select(CLIENT_COLUMNS)
      .eq("wallet", target)
      .eq("network", detectNetwork())
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("[api/clients/lookup] query failed:", error.message);
      throw new SiwsError(500, "Client lookup failed");
    }

    return NextResponse.json({ ok: true, data: { client: data ?? null } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
