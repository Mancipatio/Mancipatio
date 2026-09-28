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
import { requireModule } from "@/lib/server/feature-gate";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { clientIsSuspended } from "@/lib/server/kyc-gate";
import { raiseSanctionsHit, screenWallets } from "@/lib/server/sanctions";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

type PartyScreen = "clear" | "suspended" | "sanctioned";

export async function POST(request: Request) {
  try {
    // Pilot scope (lib/features.ts): an entry route of the secondaryTrading module.
    requireModule("secondaryTrading");
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
    // 8.5: both parties against the sanctions lists too, right before the
    // escrow opens (fail closed on mainnet; a hit raises its alert).
    const { hits } = await screenWallets(sb, [row.seller_wallet as string, row.buyer_wallet as string]);
    for (const [hit, matches] of hits) {
      await raiseSanctionsHit(sb, hit, matches, { route: "otc escrow opening (/admin/otc)", role: "counterparty" });
    }
    const party = (address: string, suspended: boolean): PartyScreen =>
      hits.has(address) ? "sanctioned" : suspended ? "suspended" : "clear";
    const seller = party(row.seller_wallet as string, sellerSuspended);
    const buyer = party(row.buyer_wallet as string, buyerSuspended);

    return NextResponse.json(
      {
        ok: true,
        data: { cleared: seller === "clear" && buyer === "clear", seller, buyer },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
