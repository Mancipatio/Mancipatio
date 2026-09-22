// POST /api/applications/submit — applicant submits a new launch application.
//
// SIWS-signed (action "applications.submit"): the applicant_wallet column is
// stamped from the VERIFIED signing wallet — a client-supplied wallet is
// ignored, so nobody can file applications on behalf of another wallet.
// Apply gate: an approved company (KYB) applies as a company; a verified
// individual (live KYC) applies with Manci opening the company. The yearly
// raise cap and max equity (0056, admin-configurable) are checked here and
// enforced again by the database trigger.

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

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "applications.submit");

    const sb = getSupabaseAdmin();
    const { kind } = await requireVerifiedApplicant(sb, wallet);

    const application = narrowApplication(params.application);
    const network = detectNetwork();
    assertWithinCapacity(await getRaiseCapacity(sb, wallet, network), application.raise_amount, application.equity_offered);

    const { data, error } = await sb
      .from("launch_applications")
      .insert({
        ...application, applicant_wallet: wallet, network,
        applicant_kind: kind,
        // Individuals always ask Manci to open the company that will issue.
        company_formation_requested: kind === "individual" || params.company_formation_requested === true,
      })
      .select("id")
      .single();
    const limit = raiseLimitError(error);
    if (limit) throw limit;
    if (error || !data) {
      console.error("[applications] submit insert failed:", error?.message);
      throw new SiwsError(500, "Could not save the application");
    }
    const id = data.id as string;

    await insertApplicationEvent(sb, {
      application_id: id,
      actor: "applicant",
      action: "submitted",
      actor_wallet: wallet,
    });

    return NextResponse.json({ ok: true, data: { id } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
