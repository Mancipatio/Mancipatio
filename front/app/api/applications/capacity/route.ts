// POST /api/applications/capacity — the signer's own raise capacity for the
// current calendar year (cap, used, remaining, max equity). Signed self-read;
// a session may authorize it (read-only). Optional `exclude` = the
// application being edited, so its own amount does not count.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { getRaiseCapacity } from "@/lib/server/raise-limits";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "applications.capacity");
    const exclude = typeof params.exclude === "string" && UUID_RE.test(params.exclude) ? params.exclude : null;
    const capacity = await getRaiseCapacity(getSupabaseAdmin(), wallet, detectNetwork(), exclude);
    return NextResponse.json({ ok: true, data: capacity }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
