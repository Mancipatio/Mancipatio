import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import {
  ownedVestingRequest,
  assertApprovedVestingHash,
  expectedVestingStep,
  requireVestingStepProof,
} from "@/lib/server/vesting-creation";
import { transactionSignature } from "@/lib/server/chain-evidence";
import { getSupabaseAdmin } from "@/lib/supabase-server";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(
      request,
      "vesting-series.record-step",
    );
    const row = await ownedVestingRequest(params.id, wallet);
    await assertApprovedVestingHash(row);
    if (!["approved", "created"].includes(row.status))
      throw new SiwsError(409, "This creation is no longer active");
    const key = typeof params.step === "string" ? params.step : "";
    if (!/^(create|finalize|positions:\d+:\d+)$/.test(key))
      throw new SiwsError(400, "Unknown creation step");
    const signature = transactionSignature(params.signature);
    await expectedVestingStep(row, key);
    const sb = getSupabaseAdmin();
    // Preserve the submitted receipt before a slow/finalizing RPC. Never overwrite
    // an existing receipt's request, step or verified state on a retry.
    const { error } = await sb
      .from("vesting_creation_steps")
      .upsert(
        { request_id: row.id, network: row.network, step_key: key, signature },
        { onConflict: "network,signature", ignoreDuplicates: true },
      );
    if (error)
      throw new SiwsError(
        500,
        "Could not save this receipt; keep its signature and retry recording",
      );
    const { data: record, error: readError } = await sb
      .from("vesting_creation_steps")
      .select("request_id,step_key,state")
      .eq("network", row.network)
      .eq("signature", signature)
      .single();
    if (readError || !record) throw new SiwsError(500, "Receipt lookup failed");
    if (record.request_id !== row.id || record.step_key !== key)
      throw new SiwsError(
        409,
        "This signature is already assigned to another creation step",
      );
    if (record.state === "verified")
      return NextResponse.json({ ok: true, data: { status: "verified" } });
    let slot;
    try {
      slot = await requireVestingStepProof(row, key, signature);
    } catch (error) {
      if (error instanceof SiwsError && error.status === 400)
        await sb
          .from("vesting_creation_steps")
          .update({ state: "failed" })
          .eq("network", row.network)
          .eq("signature", signature);
      throw error;
    }
    const { error: writeError } = await sb
      .from("vesting_creation_steps")
      .update({
        state: "verified",
        slot: slot.toString(),
        verified_at: new Date().toISOString(),
      })
      .eq("network", row.network)
      .eq("signature", signature)
      .eq("request_id", row.id);
    if (writeError)
      throw new SiwsError(
        500,
        "Verification succeeded; retry recording this signature",
      );
    return NextResponse.json({ ok: true, data: { status: "verified" } });
  } catch (error) {
    return siwsErrorResponse(error);
  }
}
