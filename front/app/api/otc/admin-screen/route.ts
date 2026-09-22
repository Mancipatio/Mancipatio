// POST /api/otc/admin-screen — compliance re-screen of a queued OTC request,
// run by the admin OTC page right before it opens the on-chain escrow
// (app/admin/otc/page.tsx createContract).
//
// /api/otc/create refuses a request when either party's dossier is
// SUSPENDED, but the escrow is opened later, by an admin. A party can be
// suspended while the request waits in the queue, so both parties are
// screened again here, with the same rule (lib/server/kyc-gate.ts
// clientIsSuspended — own or account-level dossier on the active network).
// KYC itself is not required (policy 2026-09-23); a KycGated class's buyer
// passport is checked separately by the page (checkReceiverEligibility) and
// again on-chain at settlement.
//
// Read-only. Signed or wallet session ("otc.adminScreen" is a session read
// action) + on-chain admin gate. Admins may see which party is suspended.
// Fails closed: a lookup error is a 500, never "cleared".

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { clientIsSuspended } from "@/lib/server/kyc-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

type PartyScreen = "clear" | "suspended";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "otc.adminScreen");
    await requireAdmin(wallet);

    const id = typeof params.id === "string" ? params.id : "";
    if (id.length === 0 || id.length > 64) {
      throw new SiwsError(400, "id is required");
    }

    const sb = getSupabaseAdmin();
    const { data: row, error } = await sb
      .from("otc_requests")
      .select("id, seller_wallet, buyer_wallet")
      .eq("id", id)
      .eq("network", detectNetwork())
      .maybeSingle();
    if (error) {
      console.error("[api/otc/admin-screen] request lookup failed:", error.message);
      throw new SiwsError(500, "Request lookup failed");
    }
    if (!row) throw new SiwsError(404, "OTC request not found");

    const [sellerSuspended, buyerSuspended] = await Promise.all([
      clientIsSuspended(sb, row.seller_wallet as string),
      clientIsSuspended(sb, row.buyer_wallet as string),
    ]);
    const seller: PartyScreen = sellerSuspended ? "suspended" : "clear";
    const buyer: PartyScreen = buyerSuspended ? "suspended" : "clear";

    return NextResponse.json(
      {
        ok: true,
        data: { cleared: !sellerSuspended && !buyerSuspended, seller, buyer },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
