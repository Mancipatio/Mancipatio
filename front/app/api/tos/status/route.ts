// POST /api/tos/status — minimal, unsigned check of whether a wallet has
// accepted a given ToS version. Returns only { accepted: boolean } for the
// queried (wallet, version) pair — no rows, no timestamps, no bulk listing —
// so tos_acceptances can drop its anon SELECT (migration 0036) while the
// client-side <TosGate /> interstitial keeps working. Mirrors the posture of
// /api/passport/status. Body: { wallet, version }.

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-server";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function POST(request: Request) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "Invalid JSON body" },
        { status: 400 },
      );
    }
    const b = body as { wallet?: unknown; version?: unknown };
    const wallet = typeof b.wallet === "string" ? b.wallet.trim() : "";
    const version =
      typeof b.version === "string" ? b.version.trim().slice(0, 40) : "";
    if (!BASE58_RE.test(wallet) || !version) {
      return NextResponse.json(
        { ok: false, error: "wallet and version are required" },
        { status: 400 },
      );
    }

    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("tos_acceptances")
      .select("id")
      .eq("wallet", wallet)
      .eq("version", version)
      .limit(1);
    if (error) {
      console.error("[api/tos/status] query failed:", error.message);
      return NextResponse.json(
        { ok: false, error: "ToS status check failed" },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      data: { accepted: (data?.length ?? 0) > 0 },
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Unexpected error" },
      { status: 500 },
    );
  }
}
