// POST /api/applications/resubmit — applicant edits & resubmits after a
// "needs_changes" review.
//
// SIWS-signed (action "applications.resubmit"): the signing wallet must equal
// the application's applicant_wallet. Replaces the content fields on the SAME
// row, flips status back to 'pending', stamps a fresh submitted_at and bumps
// revision_count. The KYC apply gate applies here too — a resubmission is a
// submission.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import {
  insertApplicationEvent,
  narrowApplication,
  requireVerifiedApplicant,
} from "../_lib";
import { assertWithinCapacity, getRaiseCapacity, raiseLimitError } from "@/lib/server/raise-limits";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "applications.resubmit");

    const id = typeof params.id === "string" ? params.id : "";
    if (!UUID_RE.test(id)) throw new SiwsError(400, "id must be an application UUID");

    const sb = getSupabaseAdmin();
    const { kind } = await requireVerifiedApplicant(sb, wallet);

    const { data: row, error: readError } = await sb
      .from("launch_applications")
      .select("id, applicant_wallet, status, revision_count")
      .eq("id", id)
      .eq("network", detectNetwork())
      .maybeSingle();
    if (readError) {
      console.error("[applications] resubmit read failed:", readError.message);
      throw new SiwsError(500, "Could not load the application");
    }
    if (!row) throw new SiwsError(404, "Application not found");
    if (row.applicant_wallet !== wallet) {
      throw new SiwsError(403, "Only the applicant wallet can resubmit this application");
    }
    if (row.status !== "needs_changes") {
      throw new SiwsError(
        409,
        "Only applications with requested changes can be resubmitted",
      );
    }

    const application = narrowApplication(params.application);
    // This application's own amount does not count against itself.
    assertWithinCapacity(await getRaiseCapacity(sb, wallet, detectNetwork(), id), application.raise_amount, application.equity_offered);

    const { data: updated, error } = await sb
      .from("launch_applications")
      .update({
        ...application,
        applicant_kind: kind,
        company_formation_requested: kind === "individual" || params.company_formation_requested === true,
        status: "pending",
        submitted_at: new Date().toISOString(),
        revision_count: ((row.revision_count as number | null) ?? 0) + 1,
      })
      .eq("id", id)
      .eq("network", detectNetwork())
      .eq("status", row.status)
      .select("id").maybeSingle();
    const limit = raiseLimitError(error);
    if (limit) throw limit;
    if (error) {
      console.error("[applications] resubmit update failed:", error.message);
      throw new SiwsError(500, "Could not save the resubmission");
    }

    if(!updated) throw new SiwsError(409,"Application changed; refresh before submitting another decision");
    await insertApplicationEvent(sb, {
      application_id: id,
      actor: "applicant",
      action: "resubmitted",
      actor_wallet: wallet,
    });

    return NextResponse.json({ ok: true, data: { id } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
