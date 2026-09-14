// POST /api/applications/admin-list — admin read of the launch-application
// queue. Signed + requireAdmin. launch_applications has no anon SELECT (rows
// carry founder PII: email, valuation, revenue), so the admin queue loads
// through this route. Optional `status` filter.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(
      request,
      "applications.adminList",
    );
    await requireAdmin(wallet);

    const status =
      typeof params.status === "string" ? params.status : undefined;

    const sb = getSupabaseAdmin();
    let q = sb
      .from("launch_applications")
      .select("*")
      .eq("network", detectNetwork())
      .order("created_at", { ascending: false });
    if (status) q = q.eq("status", status);
    const { data, error } = await q;
    if (error) {
      console.error("[api/applications/admin-list] query failed:", error.message);
      throw new SiwsError(500, "Could not load applications");
    }

    return NextResponse.json({ ok: true, data: { applications: data ?? [] } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
