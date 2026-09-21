// POST /api/applications/submit — applicant submits a new launch application.
//
// SIWS-signed (action "applications.submit"): the applicant_wallet column is
// stamped from the VERIFIED signing wallet — a client-supplied wallet is
// ignored, so nobody can file applications on behalf of another wallet.
// Apply gate (item 3a): requires an onboarded client row with
// kyc_status === 'verified' for the signing wallet.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import {
  insertApplicationEvent,
  narrowApplication,
  requireVerifiedCompany,
} from "../_lib";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "applications.submit");

    const sb = getSupabaseAdmin();
    await requireVerifiedCompany(sb, wallet);

    const application = narrowApplication(params.application);

    const { data, error } = await sb
      .from("launch_applications")
      .insert({ ...application, applicant_wallet: wallet, network: detectNetwork() })
      .select("id")
      .single();
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
