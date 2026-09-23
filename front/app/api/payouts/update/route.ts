// POST /api/payouts/update — payout lifecycle writes (off-chain ledger).
//
// Signed + requireAdmin. Timestamps are stamped SERVER-SIDE:
//   status -> "funded"        also sets funded_at = now
//   airdropStarted: true      sets airdrop_started_at = now
//   airdropCompleted: true    sets airdrop_completed_at = now
//
// The two airdrop stamps belong to the admin-wallet push airdrop, which is
// feature-flagged (lib/features.ts `payoutAirdrop`, off on mainnet unless
// NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP=true): with it off they are refused.
//
// Client wrapper: updatePayout() in lib/payouts.ts (action "payouts.update").

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { requireFeature } from "@/lib/server/feature-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";

const STATUSES = new Set([
  "draft",
  "snapshot_taken",
  "merkle_built",
  "funded",
  "live",
  "claimed_full",
  "cancelled",
]);

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "payouts.update");
    await requireAdmin(wallet);

    const id = typeof params.id === "string" ? params.id.trim() : "";
    if (!id || id.length > 64) throw new SiwsError(400, "Invalid payout id");

    const now = new Date().toISOString();
    const patch: Record<string, unknown> = {};

    if (params.status !== undefined) {
      if (typeof params.status !== "string" || !STATUSES.has(params.status)) {
        throw new SiwsError(400, "Unknown payout status");
      }
      patch.status = params.status;
      if (params.status === "funded") patch.funded_at = now;
    }
    if (params.fundedTx !== undefined) {
      if (
        typeof params.fundedTx !== "string" ||
        params.fundedTx.length === 0 ||
        params.fundedTx.length > 120
      ) {
        throw new SiwsError(400, "Invalid fundedTx");
      }
      patch.funded_tx = params.fundedTx;
    }
    if (params.airdropStarted === true || params.airdropCompleted === true) {
      requireFeature("payoutAirdrop");
    }
    if (params.airdropStarted === true) {
      patch.airdrop_started_at = now;
    }
    if (params.airdropCompleted === true) {
      patch.airdrop_completed_at = now;
    }
    if (Object.keys(patch).length === 0) {
      throw new SiwsError(400, "Nothing to update");
    }

    const sb = getSupabaseAdmin();
    const { error } = await sb.from("payouts").update(patch).eq("id", id);
    if (error) {
      console.error("[api/payouts/update] update failed:", error.message);
      throw new SiwsError(500, "Payout update failed");
    }

    return NextResponse.json({ ok: true, data: { id } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
