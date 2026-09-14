// POST /api/applications/mine — an applicant reads their OWN launch
// applications (and, optionally, one application's event timeline).
// Signed (SIWS): launch_applications / application_events have no anon SELECT
// (founder PII), so reads are bound to the verified signer — a caller can only
// see applications whose applicant_wallet is their own wallet.
//
// Params: {} → { applications }. { id } → { applications, events } where
// events belong to that id ONLY if the signer owns it.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "applications.mine");
    const id = typeof params.id === "string" ? params.id : null;

    const sb = getSupabaseAdmin();
    const { data: applications, error } = await sb
      .from("launch_applications")
      .select("*")
      .eq("network", detectNetwork())
      .eq("applicant_wallet", wallet)
      .order("created_at", { ascending: false });
    if (error) {
      console.error("[api/applications/mine] query failed:", error.message);
      throw new SiwsError(500, "Could not load your applications");
    }

    let events: unknown[] = [];
    if (id) {
      // Only expose events for an application the signer actually owns.
      const owns = (applications ?? []).some(
        (a) => (a as { id: string }).id === id,
      );
      if (owns) {
        const { data: evs, error: evErr } = await sb
          .from("application_events")
          .select("*")
          .eq("application_id", id)
          .order("created_at", { ascending: false });
        if (evErr) throw new SiwsError(500, "Could not load application events");
        events = evs ?? [];
      }
    }

    return NextResponse.json({
      ok: true,
      data: { applications: applications ?? [], events },
    });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
