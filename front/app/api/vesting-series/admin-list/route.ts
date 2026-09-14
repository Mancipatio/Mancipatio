import { detectNetwork } from "@/lib/network";
// POST /api/vesting-series/admin-list — team reads the full review queue
// (signed + on-chain admin gate).

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";

export async function POST(request: Request) {
  try {
    const { wallet } = await verifySigned(request, "vesting-series.admin-list");
    await requireAdmin(wallet);
    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("vesting_series")
      .select("*")
      .eq("network", detectNetwork())
      .order("created_at", { ascending: false });
    if (error) {
      console.error(
        "[api/vesting-series/admin-list] read failed:",
        error.message,
      );
      throw new SiwsError(500, "Could not load the vesting review queue");
    }
    return NextResponse.json({ ok: true, data: { rows: data ?? [] } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
