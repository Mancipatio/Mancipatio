import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { payoutSnapshotLocator, bindOriginalPayoutSnapshot, verifyPayoutSnapshotBinding, type StoredPayoutSnapshot } from "@/lib/server/payout-snapshots";
import { verifyOriginalSnapshotProof } from "@/lib/payout-snapshots";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
export const maxDuration = 30;
export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "payout-snapshots.proof");
    const locator = payoutSnapshotLocator(params, false);
    const sb = getSupabaseAdmin();
    const { data, error } = await sb.from("payout_snapshot_metadata").select("*").eq("network", detectNetwork())
      .eq("kind", locator.kind).eq("target_pda", locator.target_pda).eq("round", locator.round).eq("root_hex", locator.root_hex).abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
    if (error) throw new SiwsError(503, "Original snapshot lookup unavailable");
    if (!data) throw new SiwsError(404, "Original snapshot has not been stored; the administrator must restore the original investor list");
    const stored = data as StoredPayoutSnapshot;
    // Always the SIWS signer. A request cannot enumerate another investor's entry.
    const entry = await sb.from("payout_snapshot_proofs").select("weight,proof").eq("snapshot_id", stored.id).eq("wallet", wallet).abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
    if (entry.error) throw new SiwsError(503, "Original proof lookup unavailable");
    if (!entry.data) throw new SiwsError(404, "This wallet is not in the original investor snapshot");
    const weight = String(entry.data.weight); const proof = entry.data.proof as string[];
    if (!await verifyOriginalSnapshotProof(wallet, weight, proof, stored.root_hex)) throw new SiwsError(503, "Stored proof integrity check failed");
    // A recipient can complete a lost post-transaction acknowledgement using
    // the same finalized root/total proof; they cannot alter the snapshot.
    const verified = stored.status === "bound" ? (await verifyPayoutSnapshotBinding(stored), stored) : await bindOriginalPayoutSnapshot(stored.id);
    return NextResponse.json({ ok: true, data: { snapshot_id: stored.id, root_hex: stored.root_hex, total_weight: stored.total_weight, weight, proof, bound_slot: verified.bound_slot } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return siwsErrorResponse(error); }
}
