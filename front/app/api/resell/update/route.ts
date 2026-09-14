// POST /api/resell/update — seller withdraws their listing or marks it
// matched (optionally linking the on-chain Offer used for settlement).
// Signed (SIWS): only the listing's seller_wallet, only while 'active'.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "resell.update");

    const id = typeof params.id === "string" ? params.id : "";
    const action = typeof params.action === "string" ? params.action : "";
    if (id.length === 0 || id.length > 64) {
      throw new SiwsError(400, "id is required");
    }
    if (action !== "withdraw" && action !== "match") {
      throw new SiwsError(400, "action must be 'withdraw' or 'match'");
    }
    let linkedOfferPda: string | null = null;
    if (action === "match" && params.linked_offer_pda != null) {
      if (
        typeof params.linked_offer_pda !== "string" ||
        !BASE58_RE.test(params.linked_offer_pda)
      ) {
        throw new SiwsError(400, "linked_offer_pda is not a valid address");
      }
      linkedOfferPda = params.linked_offer_pda;
    }

    const sb = getSupabaseAdmin();
    const { data: row, error: loadErr } = await sb
      .from("resell_listings")
      .select("id, seller_wallet, status")
      .eq("id", id)
      .maybeSingle();
    if (loadErr) throw new SiwsError(500, "Listing lookup failed");
    if (!row) throw new SiwsError(404, "Listing not found");
    if (row.seller_wallet !== wallet) {
      throw new SiwsError(403, "Only the listing's seller may update it");
    }
    if (row.status !== "active") {
      throw new SiwsError(
        409,
        `Only active listings can be updated (current: ${row.status})`,
      );
    }

    const status = action === "withdraw" ? "withdrawn" : "matched";
    const patch: Record<string, unknown> =
      action === "match"
        ? { status, linked_offer_pda: linkedOfferPda }
        : { status };
    const { error } = await sb
      .from("resell_listings")
      .update(patch)
      .eq("id", id)
      .eq("status", "active");
    if (error) {
      console.error("[api/resell/update] update failed:", error.message);
      throw new SiwsError(500, "Could not update the listing");
    }

    return NextResponse.json({ ok: true, data: { id, status } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
