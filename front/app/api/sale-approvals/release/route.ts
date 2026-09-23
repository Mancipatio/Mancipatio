// POST /api/sale-approvals/release — frees an unused reservation
// ("saleApprovals.release", signed; requireAdmin).
//
// A sale reservation is released only when the chain proves it can no longer
// be used: its SaleApproval account is gone (never created, or revoked) AND
// no Sale exists for its id. Otherwise 409 — revoke the approval on-chain
// first. A treasury-mint reservation (no on-chain approval) is released by an
// admin when its mint transaction failed.
// Params: reservation_id, reason ("tx_failed" | "revoked" | "admin").

import { NextResponse } from "next/server";
import { address } from "@solana/kit";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { loadReservation, releaseReservation } from "@/lib/server/sale-capacity";
import { accountExists } from "../_lib";

const REASONS = new Set(["tx_failed", "revoked", "admin"]);

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "saleApprovals.release");
    await requireAdmin(wallet);
    const reason = typeof params.reason === "string" ? params.reason : "";
    if (!REASONS.has(reason)) throw new SiwsError(400, "reason must be tx_failed, revoked or admin");
    const sb = getSupabaseAdmin();
    const reservation = await loadReservation(sb, String(params.reservation_id ?? ""));
    if (reservation.status !== "reserved") throw new SiwsError(409, "Only an unused reservation can be released");
    if (reservation.kind === "sale") {
      if (await accountExists(address(reservation.approval_pda!))) {
        throw new SiwsError(409, "The approval still exists on-chain; revoke it first");
      }
      if (await accountExists(address(reservation.sale_pda!))) {
        throw new SiwsError(409, "A sale already used this approval; it cannot be released");
      }
    }
    const released = await releaseReservation(sb, reservation.id, reason, wallet);
    return NextResponse.json({ ok: true, data: { reservation_id: released.id, status: released.status, release_reason: released.release_reason } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
