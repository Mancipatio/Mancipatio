import { detectNetwork } from "@/lib/network";
// POST /api/vesting-series/list-mine — client reads their own series rows
// (signed; the table has NO anon policies, so this is the only read path).

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";

export async function POST(request: Request) {
  try {
    const { wallet } = await verifySigned(request, "vesting-series.list-mine");
    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("vesting_series")
      .select("*")
      .eq("network", detectNetwork())
      .eq("client_wallet", wallet)
      .order("created_at", { ascending: false });
    if (error) {
      console.error(
        "[api/vesting-series/list-mine] read failed:",
        error.message,
      );
      throw new SiwsError(500, "Could not load your vesting series");
    }
    return NextResponse.json({ ok: true, data: { rows: data ?? [] } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
