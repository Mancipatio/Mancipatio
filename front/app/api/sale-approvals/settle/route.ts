// POST /api/sale-approvals/settle — books a closed sale against the raise cap
// ("saleApprovals.settle", signed). Replaces the browser-side SPV auto-book:
// the server reads the Sale at `finalized`, finds the reservation by the
// approval the sale consumed, and books sold x price at the FX rate locked at
// reservation. Idempotent; the retry worker is the backstop.
// Gate: the sale's issuer authority (Sale -> ShareClass -> Asset -> Issuer)
// or a platform admin. Params: sale (the Sale PDA).

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { addressParam, settleSale } from "@/lib/server/sale-capacity";
import { isAdminWallet, saleIssuerAuthority } from "@/app/api/launchpad/_lib";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "saleApprovals.settle");
    const sale = addressParam(params.sale, "sale");
    if (!(await isAdminWallet(wallet))) {
      const authority = await saleIssuerAuthority(sale);
      if (authority === null) throw new SiwsError(404, "Sale not found on-chain");
      if (authority !== wallet) throw new SiwsError(403, "Only the sale's issuer authority or a platform admin may settle it");
    }
    let result;
    try {
      result = await settleSale(getSupabaseAdmin(), sale);
    } catch (err) {
      if (err instanceof SiwsError) throw err;
      console.error("[api/sale-approvals/settle] failure:", err);
      throw new SiwsError(503, "Settlement unavailable — the worker will retry it");
    }
    const r = result.reservation;
    return NextResponse.json({
      ok: true,
      data: {
        reservation_id: r.id, status: r.status, booked_amount_eur: r.booked_amount_eur ?? null,
        amount_eur: r.amount_eur, book_error: r.book_error ?? null,
      },
    });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
