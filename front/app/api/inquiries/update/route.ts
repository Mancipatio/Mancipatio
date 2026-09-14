// POST /api/inquiries/update — admin triage write on custom_inquiries.
//
// Signed + requireAdmin. Accepts a status move and/or an admin note.
// handled_by / handled_at are stamped SERVER-SIDE from the verified wallet on
// every status change — clients cannot forge who handled an inquiry.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";

const STATUSES = new Set([
  "new",
  "in_review",
  "proposed",
  "agreed",
  "rejected",
  "archived",
]);

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "inquiries.update");
    await requireAdmin(wallet);

    const id = typeof params.id === "string" ? params.id.trim() : "";
    if (!id || id.length > 64) throw new SiwsError(400, "Invalid inquiry id");

    const patch: Record<string, unknown> = {};
    if (params.status !== undefined) {
      if (
        typeof params.status !== "string" ||
        !STATUSES.has(params.status)
      ) {
        throw new SiwsError(400, "Unknown inquiry status");
      }
      patch.status = params.status;
      patch.handled_by = wallet;
      patch.handled_at = new Date().toISOString();
    }
    if (params.admin_note !== undefined) {
      if (params.admin_note === null) {
        patch.admin_note = null;
      } else if (typeof params.admin_note === "string") {
        if (params.admin_note.length > 5000) {
          throw new SiwsError(400, "Note too long (max 5000 characters)");
        }
        patch.admin_note = params.admin_note;
      } else {
        throw new SiwsError(400, "admin_note must be a string");
      }
    }
    if (Object.keys(patch).length === 0) {
      throw new SiwsError(400, "Nothing to update");
    }

    const sb = getSupabaseAdmin();
    const { error } = await sb
      .from("custom_inquiries")
      .update(patch)
      .eq("id", id);
    if (error) {
      console.error("[api/inquiries/update] update failed:", error.message);
      throw new SiwsError(500, "Could not update inquiry");
    }

    return NextResponse.json({ ok: true, data: { id } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
