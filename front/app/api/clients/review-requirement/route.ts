// POST /api/clients/review-requirement — admin approves/rejects a submitted
// KYC requirement (SIWS + requireAdmin). Action: "clients.review-requirement".
// Client half: lib/clients.ts reviewRequirement().
//
// On approval the parent client's kyc_status is recomputed server-side:
// a `more_info` client with no remaining open requirements flips to `pending`
// (returned as `recomputed` so the UI can explain the transition).

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import {
  assertPositiveInt,
  fetchClientOr404,
  oneOf,
  recomputeKycFromRequirements,
} from "../_helpers";

const REVIEW_STATUSES = ["approved", "rejected"] as const;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(
      request,
      "clients.review-requirement",
    );
    await requireAdmin(wallet);

    const id = assertPositiveInt(params.id, "id");
    const status = oneOf(params.status, REVIEW_STATUSES, "status");

    const sb = getSupabaseAdmin();
    const { data: req, error: readErr } = await sb
      .from("kyc_requirements")
      .select("id, client_id, status")
      .eq("id", id)
      .maybeSingle();
    if (readErr) throw new SiwsError(500, "Database read failed");
    if (!req) throw new SiwsError(404, "Requirement not found");
    await fetchClientOr404(sb, String(req.client_id));

    const { error } = await sb
      .from("kyc_requirements")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) {
      console.warn("[api/clients/review-requirement] failed:", error.message);
      throw new SiwsError(500, error.message);
    }

    const recomputed =
      status === "approved"
        ? await recomputeKycFromRequirements(sb, (req as { client_id: string }).client_id)
        : null;

    return NextResponse.json({ ok: true, data: { status, recomputed } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
