// POST /api/applications/admin-events — admin read of one application's event
// timeline. Signed + requireAdmin (application_events has no anon SELECT).

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(
      request,
      "applications.adminEvents",
    );
    await requireAdmin(wallet);

    const applicationId =
      typeof params.application_id === "string" ? params.application_id : "";
    if (!applicationId) throw new SiwsError(400, "application_id is required");

    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("application_events")
      .select("*")
      .eq("application_id", applicationId)
      .order("created_at", { ascending: false });
    if (error) {
      console.error("[api/applications/admin-events] query failed:", error.message);
      throw new SiwsError(500, "Could not load application events");
    }

    return NextResponse.json({ ok: true, data: { events: data ?? [] } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
