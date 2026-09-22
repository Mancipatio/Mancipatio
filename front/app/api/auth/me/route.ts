// POST /api/auth/me — who is signed in with email/Google (cookie only). Returns
// the minimal header identity; the full profile is /api/account/me.
import { NextResponse } from "next/server";
import { detectNetwork } from "@/lib/network";
import { siwsErrorResponse } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { readAccountSession } from "@/lib/server/account-auth";
import { assertSameSite } from "@/lib/server/auth-login";

export async function POST(request: Request) {
  try {
    assertSameSite(request);
    const session = readAccountSession(request);
    if (!session) return NextResponse.json({ ok: true, data: { account: null } }, { headers: { "Cache-Control": "no-store" } });
    const { data } = await getSupabaseAdmin().from("account_profiles")
      .select("id,email,display_name,primary_wallet").eq("id", session.a).eq("network", detectNetwork()).maybeSingle();
    return NextResponse.json({ ok: true, data: { account: data ?? null, expires_at: new Date(session.exp).toISOString() } },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return siwsErrorResponse(error);
  }
}
