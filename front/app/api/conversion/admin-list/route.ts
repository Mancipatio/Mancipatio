// POST /api/conversion/admin-list — admin read of the conversion queue.
// Signed + requireAdmin (same stance as /api/compliance/list): the table has
// no anon SELECT because rows carry holder contact details (PII), so the
// custody admin page loads the queue through this route.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

export async function POST(request: Request) {
  try {
    const { wallet } = await verifySigned(request, "conversion.adminList");
    await requireAdmin(wallet);

    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("conversion_requests")
      .select("*")
      .eq("network", detectNetwork())
      .order("created_at", { ascending: false });
    if (error) {
      console.error("[api/conversion/admin-list] query failed:", error.message);
      throw new SiwsError(500, "Could not load conversion requests");
    }

    return NextResponse.json({ ok: true, data: { requests: data ?? [] } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
