// POST /api/resell/moderate — admin removes a listing from the public board
// or restores one removed in error. Signed (SIWS) + on-chain admin gate.
// moderated_by is stamped with the VERIFIED admin wallet server-side.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "resell.moderate");
    await requireAdmin(wallet);

    const id = typeof params.id === "string" ? params.id : "";
    const action = typeof params.action === "string" ? params.action : "";
    if (id.length === 0 || id.length > 64) {
      throw new SiwsError(400, "id is required");
    }
    if (action !== "remove" && action !== "restore") {
      throw new SiwsError(400, "action must be 'remove' or 'restore'");
    }

    const status = action === "remove" ? "removed" : "active";
    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("resell_listings")
      .update({
        status,
        moderated_by: wallet,
        moderated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (error) {
      console.error("[api/resell/moderate] update failed:", error.message);
      throw new SiwsError(500, "Could not moderate the listing");
    }
    if (!data) throw new SiwsError(404, "Listing not found");

    return NextResponse.json({ ok: true, data: { id, status } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
