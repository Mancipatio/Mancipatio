import { NextResponse } from "next/server";
import { address } from "@solana/kit";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import {
  fetchMaybeVestingSeries,
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  VestingSeriesStatus,
  findSeriesPda,
} from "@/lib/generated/asset_registry";
import { getServerRpc } from "@/lib/server/rpc";
import {
  ownedVestingRequest,
  requireVestingStepProof,
} from "@/lib/server/vesting-creation";
import { transactionSignature } from "@/lib/server/chain-evidence";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(
      request,
      "vesting-series.mark-cancelled",
    );
    const row = await ownedVestingRequest(params.id, wallet);
    const tx = transactionSignature(params.tx);
    if (row.status === "cancelled" && row.cancelled_tx === tx)
      return NextResponse.json({ ok: true, data: { id: row.id } });
    if (!["approved", "created"].includes(row.status) || !row.series_pda)
      throw new SiwsError(
        409,
        "Only a prepared or finalized series can be marked cancelled",
      );
    const slot = await requireVestingStepProof(row, "cancel", tx);
    const onchain = await fetchMaybeVestingSeries(
      getServerRpc(),
      address(row.series_pda),
      {
        commitment: "finalized",
        minContextSlot: slot,
        abortSignal: AbortSignal.timeout(12_000),
      },
    );
    if (
      !onchain.exists ||
      onchain.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
      onchain.data.authority !== wallet ||
      onchain.data.status !== VestingSeriesStatus.Cancelled ||
      onchain.data.tokenMint !== row.token_mint ||
      (
        await findSeriesPda({
          authority: address(wallet),
          seriesId: onchain.data.seriesId,
        })
      )[0] !== row.series_pda
    )
      throw new SiwsError(
        400,
        "The request's on-chain series is not cancelled by its authority",
      );
    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("vesting_series")
      .update({ status: "cancelled", cancelled_tx: tx })
      .eq("id", row.id)
      .eq("network", row.network)
      .eq("client_wallet", wallet)
      .eq("status", row.status)
      .select("id")
      .maybeSingle();
    if (error)
      throw new SiwsError(
        500,
        "Could not record cancellation; retry the same signature",
      );
    if (data)
      await sb
        .from("vesting_series_events")
        .insert({
          series_id: row.id,
          actor: "client",
          action: "cancelled_onchain",
          actor_wallet: wallet,
        });
    else {
      const latest = await ownedVestingRequest(row.id, wallet);
      if (latest.status !== "cancelled" || latest.cancelled_tx !== tx)
        throw new SiwsError(409, "Request changed; reload it before retrying");
    }
    return NextResponse.json({ ok: true, data: { id: row.id } });
  } catch (error) {
    return siwsErrorResponse(error);
  }
}
