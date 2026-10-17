// POST /api/resell/moderate — admin removes a listing from the public board
// or restores one removed in error. Signed (SIWS) + on-chain admin gate.
// moderated_by is stamped with the VERIFIED admin wallet server-side.
// Restore applies to a REMOVED listing only: a post its seller withdrew or
// marked matched keeps that status, so moderation can never put a seller's
// contact back on the public board (public only while a listing is active,
// 0082). Remove applies to a listing that is not removed already, so a
// second call does not restamp moderated_by/at. Anything else answers 409.

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

    const sb = getSupabaseAdmin();
    const { data: row, error: loadErr } = await sb
      .from("resell_listings")
      .select("id, status")
      .eq("id", id)
      .maybeSingle();
    if (loadErr) throw new SiwsError(500, "Listing lookup failed");
    if (!row) throw new SiwsError(404, "Listing not found");
    if (action === "restore" && row.status !== "removed") {
      throw new SiwsError(
        409,
        `Only a removed listing can be restored (current: ${row.status})`,
      );
    }
    if (action === "remove" && row.status === "removed") {
      throw new SiwsError(409, "Listing is already removed");
    }

    const status = action === "remove" ? "removed" : "active";
    // The same condition on the update itself: a withdrawal (or another
    // moderator) between the lookup and the update matches no row.
    let update = sb
      .from("resell_listings")
      .update({
        status,
        moderated_by: wallet,
        moderated_at: new Date().toISOString(),
      })
      .eq("id", id);
    update = action === "restore" ? update.eq("status", "removed") : update.neq("status", "removed");
    const { data, error } = await update.select("id").maybeSingle();
    if (error) {
      console.error("[api/resell/moderate] update failed:", error.message);
      throw new SiwsError(500, "Could not moderate the listing");
    }
    if (!data) throw new SiwsError(409, "Listing changed meanwhile — reload and try again");

    return NextResponse.json({ ok: true, data: { id, status } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
