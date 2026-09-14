// POST /api/compliance/resolve — resolve/dismiss/escalate an AML alert with a
// mandatory written reason (from /admin/compliance).
//
// Signed route, platform-admin only. `resolved_by` is ALWAYS the verified
// signer wallet and `resolved_at` is stamped server-side — the client cannot
// attribute a resolution to another wallet or backdate it.
// Client wrapper: resolveAlert() in lib/compliance.ts
// (action "compliance.resolve").

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOLUTIONS = new Set(["dismissed", "escalated", "resolved"]);

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(
      request,
      "compliance.resolve",
    );
    await requireAdmin(wallet);

    const id = typeof params.id === "string" ? params.id.trim() : "";
    if (!UUID_RE.test(id)) {
      throw new SiwsError(400, "id must be a UUID");
    }

    const status = typeof params.status === "string" ? params.status : "";
    if (!RESOLUTIONS.has(status)) {
      throw new SiwsError(
        400,
        "status must be dismissed, escalated or resolved",
      );
    }

    const note = typeof params.note === "string" ? params.note.trim() : "";
    if (!note || note.length > 2000) {
      throw new SiwsError(400, "A resolution note is required (≤2000 chars)");
    }

    const sb = getSupabaseAdmin();
    const { error } = await sb
      .from("compliance_alerts")
      .update({
        status,
        resolution_note: note,
        resolved_by: wallet,
        resolved_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (error) {
      console.error("[api/compliance/resolve] update failed:", error.message);
      throw new SiwsError(500, "Alert update failed");
    }

    return NextResponse.json({ ok: true, data: { id, status } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
