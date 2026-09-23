// POST /api/payouts/recipients — recipient row bookkeeping for airdrop runs.
//
// Signed + requireAdmin. Two operations:
//   op "mark_claimed": stamp a sent batch (claimed / claimed_at / claimed_tx,
//                      clears send_error) — claimed_at is server time;
//   op "set_error":    record a send failure on still-unclaimed rows only
//                      (claimed rows are never overwritten).
//
// "mark_claimed" records a push-airdrop batch, which is feature-flagged
// (lib/features.ts `payoutAirdrop`, off on mainnet unless
// NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP=true): with it off the op is refused.
//
// Client wrappers: markPayoutRecipientsClaimed() / setPayoutRecipientsSendError()
// in lib/payouts.ts (action "payouts.recipients").

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { requireFeature } from "@/lib/server/feature-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_BATCH = 200;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "payouts.recipients");
    await requireAdmin(wallet);

    const payoutId =
      typeof params.payoutId === "string" ? params.payoutId.trim() : "";
    if (!payoutId || payoutId.length > 64) {
      throw new SiwsError(400, "Invalid payout id");
    }

    const op = params.op;
    if (op !== "mark_claimed" && op !== "set_error") {
      throw new SiwsError(400, "op must be mark_claimed or set_error");
    }
    if (op === "mark_claimed") requireFeature("payoutAirdrop");

    const wallets = Array.isArray(params.wallets) ? params.wallets : null;
    if (
      !wallets ||
      wallets.length === 0 ||
      wallets.length > MAX_BATCH ||
      !wallets.every((w) => typeof w === "string" && BASE58_RE.test(w))
    ) {
      throw new SiwsError(
        400,
        `wallets must be 1–${MAX_BATCH} base58 addresses`,
      );
    }

    const sb = getSupabaseAdmin();

    if (op === "mark_claimed") {
      const claimedTx =
        typeof params.claimedTx === "string" ? params.claimedTx.trim() : "";
      if (!claimedTx || claimedTx.length > 120) {
        throw new SiwsError(400, "claimedTx required (≤120 chars)");
      }
      const { error } = await sb
        .from("payout_recipients")
        .update({
          claimed: true,
          claimed_at: new Date().toISOString(),
          claimed_tx: claimedTx,
          send_error: null,
        })
        .eq("payout_id", payoutId)
        .in("wallet", wallets as string[]);
      if (error) {
        console.error("[api/payouts/recipients] mark_claimed failed:", error.message);
        throw new SiwsError(500, "Recording sent batch failed");
      }
    } else {
      const sendError =
        typeof params.sendError === "string"
          ? params.sendError.slice(0, 1000)
          : "";
      if (!sendError) throw new SiwsError(400, "sendError required");
      const { error } = await sb
        .from("payout_recipients")
        .update({ send_error: sendError })
        .eq("payout_id", payoutId)
        .eq("claimed", false)
        .in("wallet", wallets as string[]);
      if (error) {
        console.error("[api/payouts/recipients] set_error failed:", error.message);
        throw new SiwsError(500, "Recording send error failed");
      }
    }

    return NextResponse.json({
      ok: true,
      data: { payoutId, op, count: wallets.length },
    });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
