// POST /api/delivery/cancel — holder cancels their own request pre-deposit.
// Signed (SIWS): only the request's holder_wallet may cancel, and only while
// the request is still 'requested' (nothing has moved on-chain yet). Later
// cancellations (after the vault opened) are an admin action.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "delivery.cancel");

    const id = typeof params.id === "string" ? params.id : "";
    if (id.length === 0 || id.length > 64) {
      throw new SiwsError(400, "id is required");
    }

    const sb = getSupabaseAdmin();
    const { data: row, error: loadErr } = await sb
      .from("delivery_requests")
      .select("id, holder_wallet, status")
      .eq("id", id)
      .eq("network", detectNetwork())
      .maybeSingle();
    if (loadErr) throw new SiwsError(500, "Request lookup failed");
    if (!row) throw new SiwsError(404, "Delivery request not found");
    if (row.holder_wallet !== wallet) {
      throw new SiwsError(403, "Only the request's holder may cancel it");
    }
    if (row.status !== "requested") {
      throw new SiwsError(
        409,
        `Only 'requested' requests can be cancelled by the holder (current: ${row.status})`,
      );
    }

    const { data: updated, error } = await sb
      .from("delivery_requests")
      .update({ status: "cancelled" })
      .eq("id", id)
      .eq("network", detectNetwork())
      .eq("status", "requested")
      .select("id").maybeSingle();
    if (error) {
      console.error("[api/delivery/cancel] update failed:", error.message);
      throw new SiwsError(500, "Could not cancel the request");
    }

    if (!updated) throw new SiwsError(409, "Request changed; refresh before cancelling");
    return NextResponse.json({ ok: true, data: { id, status: "cancelled" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
