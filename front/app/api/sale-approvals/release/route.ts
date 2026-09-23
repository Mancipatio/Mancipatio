// POST /api/sale-approvals/release — frees an unused reservation
// ("saleApprovals.release", signed; requireAdmin).
//
// A reservation is released only when the chain proves it can no longer be
// used, because a released reservation no longer counts against the cap:
//   * sale: neither the SaleApproval nor a Sale exists (one getMultipleAccounts
//     read, one slot). If the approval was never seen on-chain, its approve_sale
//     transaction may still be in flight, so the caller must also prove it can
//     no longer land: its signature failed, or the finalized chain is past its
//     blockhash's last valid block height and the approval is absent there.
//   * treasury_mint: the same proof for the mint transaction (a signature that
//     succeeded is booked with saleApprovals.treasuryMintBook instead).
// Otherwise 409; the retry worker releases dead reservations, and adopts an
// approval that lands after a release (orphan scan).
// Params: reservation_id, reason ("tx_failed" | "revoked" | "admin"),
// optional signature and last_valid_block_height (decimal string).

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { loadReservation, releaseReservation } from "@/lib/server/sale-capacity";
import { blockhashExpired, readApprovalAndSale, signatureOutcome } from "@/lib/server/sale-capacity-chain";

const REASONS = new Set(["tx_failed", "revoked", "admin"]);
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;
const IN_FLIGHT =
  "The transaction may still land. Retry once its blockhash has expired (about a minute), or leave it: the retry worker releases it.";

async function chain<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    console.error("[api/sale-approvals/release] RPC failure:", err);
    throw new SiwsError(503, "On-chain check unavailable — try again");
  }
}

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "saleApprovals.release");
    await requireAdmin(wallet);
    const reason = typeof params.reason === "string" ? params.reason : "";
    if (!REASONS.has(reason)) throw new SiwsError(400, "reason must be tx_failed, revoked or admin");
    const signature = typeof params.signature === "string" && SIG_RE.test(params.signature) ? params.signature : null;
    const lvbhText = params.last_valid_block_height;
    const lastValid = typeof lvbhText === "string" && /^\d{1,20}$/.test(lvbhText) ? BigInt(lvbhText) : null;
    const sb = getSupabaseAdmin();
    const reservation = await loadReservation(sb, String(params.reservation_id ?? ""));
    if (reservation.status !== "reserved") throw new SiwsError(409, "Only an unused reservation can be released");

    // Proof that the sending transaction can no longer land.
    const cannotLand = async (absentAtFinalized: () => Promise<boolean>) => {
      if (signature) {
        const outcome = await chain(() => signatureOutcome(signature));
        if (outcome === "failed") return true;
        if (outcome === "succeeded") return false;
      }
      if (lastValid === null) return false;
      if (!(await chain(() => blockhashExpired(lastValid)))) return false;
      return absentAtFinalized();
    };

    if (reservation.kind === "sale") {
      const state = await chain(() => readApprovalAndSale(reservation.approval_pda!, reservation.sale_pda!, "confirmed"));
      if (state.approval) throw new SiwsError(409, "The approval still exists on-chain; revoke it first");
      if (state.sale) throw new SiwsError(409, "A sale already used this approval; it cannot be released");
      if (!reservation.chain_confirmed_at) {
        const proven = await cannotLand(async () => {
          const final = await chain(() => readApprovalAndSale(reservation.approval_pda!, reservation.sale_pda!, "finalized"));
          return !final.approval && !final.sale;
        });
        if (!proven) throw new SiwsError(409, IN_FLIGHT);
      }
    } else {
      if (signature && (await chain(() => signatureOutcome(signature))) === "succeeded") {
        throw new SiwsError(409, "The treasury mint landed; book it instead of releasing it");
      }
      if (!(await cannotLand(async () => true))) throw new SiwsError(409, IN_FLIGHT);
    }
    const released = await releaseReservation(sb, reservation.id, reason, wallet);
    return NextResponse.json({ ok: true, data: { reservation_id: released.id, status: released.status, release_reason: released.release_reason } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
