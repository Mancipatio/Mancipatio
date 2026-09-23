// POST /api/sale-approvals/confirm — step 3 of an Admin sale approval
// ("saleApprovals.confirm", signed; requireAdmin). Reads the on-chain
// SaleApproval at `confirmed` and requires every field to equal the
// reservation (terms, application hash, approved_by = the reserving admin).
// A mismatch is recorded on the reservation and answered with 409.
// Params: reservation_id, signature (optional, the approve_sale transaction).

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import {
  adoptApproval,
  approvalMismatches,
  confirmReservation,
  fetchApproval,
  loadReservation,
} from "@/lib/server/sale-capacity";

const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "saleApprovals.confirm");
    await requireAdmin(wallet);
    const sb = getSupabaseAdmin();
    const reservation = await loadReservation(sb, String(params.reservation_id ?? ""));
    if (reservation.kind !== "sale") throw new SiwsError(400, "Not a sale-approval reservation");
    const signature = typeof params.signature === "string" && SIG_RE.test(params.signature) ? params.signature : null;
    let approval;
    try {
      approval = await fetchApproval(reservation.approval_pda!);
    } catch (err) {
      console.error("[api/sale-approvals/confirm] RPC failure:", err);
      throw new SiwsError(503, "On-chain check unavailable — the worker will confirm it; try again later");
    }
    if (!approval) {
      throw new SiwsError(409, "The approval is not on-chain (yet). If the transaction failed, release the reservation.");
    }
    const fields = approvalMismatches(reservation, approval);
    if (fields.length) {
      // The chain is the truth: count the approval at its on-chain terms
      // (never less than reserved), and ask for a revoke.
      const adopted = await adoptApproval(sb, approval, reservation.approval_pda!, reservation, "confirm");
      const message = `The on-chain approval does not match the reservation (${fields.join(", ")}). It is now counted at its on-chain terms${adopted.over_cap ? ", which puts the subject over its raise cap" : ""}; revoke it if it is not intended.`;
      await sb.from("sale_capacity_reservations").update({ last_error: message }).eq("id", reservation.id);
      await sb.from("audit_events").insert({
        network: reservation.network, ix_name: "sale_capacity_alert", category: "launchpad", actor_wallet: wallet,
        target_label: reservation.approval_pda, reason: message.slice(0, 1000), status: "failed",
        metadata: { reservation_id: reservation.id, subject: reservation.subject, fields, actor_verified: true, actor_source: "confirm" },
      });
      throw new SiwsError(409, message);
    }
    const confirmed = await confirmReservation(sb, reservation.id, signature);
    return NextResponse.json({ ok: true, data: { reservation_id: confirmed.id, status: confirmed.status, chain_confirmed_at: confirmed.chain_confirmed_at } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
