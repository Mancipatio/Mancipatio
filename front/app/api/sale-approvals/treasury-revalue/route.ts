// POST /api/sale-approvals/treasury-revalue — the super admin re-values a
// treasury mint the ledger adopted at its floor value
// ("saleApprovals.treasuryRevalue", signed; Talas 5.1, D21).
// Params: reservation_id, amount_eur, reason (at least 10 characters).
// 0073 revalue_treasury_mint refuses anything but a booked, adopted treasury
// row and any value below the recomputed floor; the linked SPV issuance
// follows. Audited on the server; a ledger alert REVALUED (critical when the
// subject is now over its cap).

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireSuperAdmin } from "@/lib/server/admin-gate";
import { actorSourceOf, writeServerAudit } from "@/lib/server/audit";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { UUID_RE, capacityError, ledgerAlert, type Reservation } from "@/lib/server/sale-capacity";

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(request, "saleApprovals.treasuryRevalue");
    await requireSuperAdmin(wallet);
    const id = typeof params.reservation_id === "string" ? params.reservation_id : "";
    if (!UUID_RE.test(id)) throw new SiwsError(400, "reservation_id must be a UUID");
    const amount = typeof params.amount_eur === "number" ? params.amount_eur : NaN;
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) throw new SiwsError(400, "amount_eur must be a positive number");
    const reason = typeof params.reason === "string" ? params.reason.trim() : "";
    if (reason.length < 10 || reason.length > 500) throw new SiwsError(400, "A reason of 10 to 500 characters is required");
    const sb = getSupabaseAdmin();
    const { data, error } = await sb.rpc("revalue_treasury_mint", {
      p_id: id, p_amount_eur: amount, p_reason: reason, p_by: wallet,
    });
    if (error) throw capacityError(error);
    const row = data as Reservation & { over_cap?: boolean; previous_amount_eur?: number | string };
    await writeServerAudit(sb, {
      ix_name: "treasury_mint_revalue", category: "launchpad", actor_wallet: wallet, actor_source: actorSourceOf(via),
      reason, target_label: id,
      metadata: { reservation_id: id, from: row.previous_amount_eur ?? null, to: row.amount_eur, over_cap: row.over_cap === true },
    }).catch(() => console.error("[api/sale-approvals/treasury-revalue] audit row not written"));
    await ledgerAlert(sb, row, "REVALUED", row.over_cap ? "critical" : "medium",
      `The super admin re-valued an adopted treasury mint to €${row.amount_eur}${row.over_cap ? " — the subject is now OVER its raise cap" : ""}`,
      { amount: String(row.amount_eur) }, { previous_amount_eur: String(row.previous_amount_eur ?? ""), by: wallet });
    return NextResponse.json({
      ok: true,
      data: { reservation_id: id, amount_eur: row.amount_eur, previous_amount_eur: row.previous_amount_eur ?? null, over_cap: row.over_cap === true },
    });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
