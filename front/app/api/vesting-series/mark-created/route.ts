import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import {
  ownedVestingRequest,
  readVestingCreationState,
  requireVestingStepProof,
} from "@/lib/server/vesting-creation";
import { transactionSignature } from "@/lib/server/chain-evidence";

/** The finalization signature and every approved term/position/escrow are verified at finalized commitment. */
export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(
      request,
      "vesting-series.mark-created",
    );
    const row = await ownedVestingRequest(params.id, wallet);
    const tx = transactionSignature(params.tx);
    if (row.status === "created" && row.created_tx === tx)
      return NextResponse.json({ ok: true, data: { id: row.id } });
    if (row.status !== "approved" || !row.creation_prepared_at)
      throw new SiwsError(
        409,
        "Only a prepared approved series can be marked created",
      );
    if (
      params.series_id !== row.series_id ||
      params.series_pda !== row.series_pda ||
      params.escrow !== row.escrow
    )
      throw new SiwsError(
        400,
        "Addresses do not match the persisted creation intent",
      );
    const slot = await requireVestingStepProof(row, "finalize", tx);
    await readVestingCreationState(row, true, slot);
    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("vesting_series")
      .update({ status: "created", created_tx: tx })
      .eq("id", row.id)
      .eq("network", row.network)
      .eq("client_wallet", wallet)
      .eq("status", "approved")
      .eq("creation_terms_hash", row.approved_terms_hash!)
      .select("id")
      .maybeSingle();
    if (error)
      throw new SiwsError(
        500,
        "Could not record finalization; retry the saved signature",
      );
    if (!data) {
      const latest = await ownedVestingRequest(row.id, wallet);
      if (latest.status !== "created" || latest.created_tx !== tx)
        throw new SiwsError(
          409,
          "Series state changed; reload before retrying",
        );
    } else
      await sb
        .from("vesting_series_events")
        .insert({
          series_id: row.id,
          actor: "client",
          action: "created_onchain",
          actor_wallet: wallet,
        });
    return NextResponse.json({ ok: true, data: { id: row.id } });
  } catch (error) {
    return siwsErrorResponse(error);
  }
}
