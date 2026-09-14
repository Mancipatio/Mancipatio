import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { address } from "@solana/kit";
import {
  findSeriesPda,
  findCreateVestingSeriesEscrowPda,
} from "@/lib/generated/asset_registry";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import {
  ownedVestingRequest,
  assertApprovedVestingHash,
} from "@/lib/server/vesting-creation";
import { assertSupportedVestingTerms } from "@/lib/vesting-terms";
import { buildVestingCreationSteps } from "@/lib/vesting-creation";
import { fetchVestingMintTokenProgram } from "@/lib/transaction-builders";
import { getServerRpc } from "@/lib/server/rpc";
import { getSupabaseAdmin } from "@/lib/supabase-server";

/** SIWS binds the request id AND the reviewed terms hash before any wallet transaction. */
export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(
      request,
      "vesting-series.prepare-creation",
    );
    let row = await ownedVestingRequest(params.id, wallet);
    if (row.status !== "approved" && row.status !== "created")
      throw new SiwsError(409, "Only an approved request can be prepared");
    await assertApprovedVestingHash(row);
    if (params.terms_hash !== row.approved_terms_hash)
      throw new SiwsError(409, "Reviewed terms changed; reload the request");
    if (!row.creation_prepared_at) {
      try {
        assertSupportedVestingTerms(row, Math.floor(Date.now() / 1000));
      } catch (error) {
        throw new SiwsError(
          400,
          error instanceof Error ? error.message : "Unsupported terms",
        );
      }
      // Full u64 stored as text, never rounded through a JSON number.
      const seriesId = randomBytes(8).readBigUInt64LE().toString();
      const [series] = await findSeriesPda({
        authority: address(wallet),
        seriesId: BigInt(seriesId),
      });
      const [escrow] = await findCreateVestingSeriesEscrowPda({ series });
      const intent = {
        ...row,
        series_id: seriesId,
        series_pda: series,
        escrow,
        creation_terms_hash: row.approved_terms_hash,
      };
      const tokenProgram = await fetchVestingMintTokenProgram(
        getServerRpc(),
        address(row.token_mint),
      );
      await buildVestingCreationSteps(intent, tokenProgram); // size-check before persisting an unusable intent
      const { error } = await getSupabaseAdmin()
        .from("vesting_series")
        .update({
          series_id: seriesId,
          series_pda: series,
          escrow,
          creation_terms_hash: row.approved_terms_hash,
          creation_prepared_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .eq("network", row.network)
        .eq("client_wallet", wallet)
        .eq("status", "approved")
        .eq("approved_terms_hash", row.approved_terms_hash)
        .is("creation_prepared_at", null)
        .is("series_pda", null);
      if (error)
        throw new SiwsError(
          500,
          "Could not persist the creation intent; no transaction has been sent",
        );
      row = await ownedVestingRequest(row.id, wallet); // concurrent attempts always return the persisted winner
      if (!row.creation_prepared_at)
        throw new SiwsError(
          409,
          "A legacy or concurrent creation needs reconciliation before continuing",
        );
    }
    return NextResponse.json({ ok: true, data: { row } });
  } catch (error) {
    return siwsErrorResponse(error);
  }
}
