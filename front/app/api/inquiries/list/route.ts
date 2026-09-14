// POST /api/inquiries/list — admin triage read of custom_inquiries.
//
// Signed + requireAdmin. Reads must go through the service role because
// W3-RLS locks custom_inquiries to "NO anon anything" (submissions contain
// PII — names, emails, business ideas).

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

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
    const { wallet, params } = await verifySigned(request, "inquiries.list");
    await requireAdmin(wallet);

    let status: string | null = null;
    if (params.status !== undefined && params.status !== null) {
      if (typeof params.status !== "string" || !STATUSES.has(params.status)) {
        throw new SiwsError(400, "Unknown inquiry status");
      }
      status = params.status;
    }

    const sb = getSupabaseAdmin();
    let q = sb
      .from("custom_inquiries")
      .select("*")
      .eq("network", detectNetwork())
      .order("created_at", { ascending: false });
    if (status) q = q.eq("status", status);
    const { data, error } = await q;
    if (error) {
      console.error("[api/inquiries/list] query failed:", error.message);
      throw new SiwsError(500, "Could not load inquiries");
    }

    return NextResponse.json({ ok: true, data: { inquiries: data ?? [] } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
