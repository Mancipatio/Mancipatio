// POST /api/admin-config/read — admin read of the integrations registry or
// the notifications timeline (scope-selected, one signature per page load).
//
// Signed + requireAdmin. These two tables are read ONLY by admin pages and
// their contents are not public-safe:
//   - notifications rows include per-wallet OTC deal traces (audience_param =
//     a specific user wallet, body text with deal details, admin author
//     wallet) — private user data;
//   - integrations exposes the vendor inventory, live health status and
//     free-form config/notes JSON — infrastructure recon with no public
//     reader.
// Moving reads here lets the RLS follow-up drop anon SELECT on both tables.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "adminConfig.read");
    await requireAdmin(wallet);

    const scope = typeof params.scope === "string" ? params.scope : "";
    const sb = getSupabaseAdmin();

    if (scope === "integrations") {
      const { data, error } = await sb
        .from("integrations")
        .select("*")
        .order("kind", { ascending: true })
        .order("slug", { ascending: true });
      if (error) {
        console.error("[api/admin-config/read] integrations query failed:", error.message);
        throw new SiwsError(500, "Could not load integrations");
      }
      return NextResponse.json({ ok: true, data: { integrations: data ?? [] } });
    }

    if (scope === "notifications") {
      const [list, resend] = await Promise.all([
        sb
          .from("notifications")
          .select("*")
          .order("created_at", { ascending: false }),
        sb
          .from("integrations")
          .select("status")
          .eq("slug", "resend")
          .maybeSingle(),
      ]);
      if (list.error) {
        console.error("[api/admin-config/read] notifications query failed:", list.error.message);
        throw new SiwsError(500, "Could not load notifications");
      }
      // resend.error is non-fatal — absence just renders the "not configured"
      // banner, matching the previous client-side behavior.
      return NextResponse.json({
        ok: true,
        data: {
          notifications: list.data ?? [],
          resendConfigured: resend.data?.status === "configured",
        },
      });
    }

    throw new SiwsError(400, "scope must be 'integrations' or 'notifications'");
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
