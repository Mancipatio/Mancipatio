// POST /api/compliance/screen-wallet — the signing wallet screens ITSELF
// against the sanctions lists before an on-chain entry the server does not
// mediate (8.5): the primary buy of an Open class mints without the transfer
// hook, so the program cannot refuse a listed buyer, and the purchase record
// afterwards is too late to stop the payment. The sale page asks this right
// before it builds the buy.
//
// Signed or wallet session ("compliance.screenWallet" is a session read: it
// answers only about the caller's own wallet, and its one write is the
// compliance alert of a hit, deduplicated per wallet). 200 when clear; 403
// on a hit (the alert is raised); 503 on mainnet while the list is unusable
// (lib/server/sanctions.ts). This covers a buy made through the UI only. The
// program remains the only on-chain control; a wallet that skips the UI (its
// own script, no purchase record) is caught after the fact by the alarm
// worker, which screens the signer of every finalized buy the indexer sees
// (lib/server/onchain-screening.ts).
//
// It also checks the platform link (D2, 2026-10-03): buying needs a wallet
// signed in on the site with the Terms in force accepted. After a clear
// screen (a listed wallet is reported even without an acceptance), the
// recorded acceptance is required where the server gate is enforced (mainnet;
// devnet with TOS_SERVER_GATE=enforce): no row → 409 with "accept the Terms",
// an unreadable table → 503 (lib/server/tos-gate.ts). The Terms gate on the
// marketplace normally records it before the sale page opens. A buy without
// it (a script) is caught after the fact by the alarm worker
// (lib/server/onchain-link-check.ts).
//
// Client wrapper: screenOwnWallet() in lib/compliance.ts.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { requireSanctionsClear } from "@/lib/server/sanctions";
import { requireAcceptedTos } from "@/lib/server/tos-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { requireArea } from "@/lib/server/feature-gate";

export async function POST(request: Request) {
  try {
    // KYC-only mode (lib/features.ts): the buyer's own wallet screen (lib/compliance.ts screenOwnWallet, the buy flow) is a primary-sales entry.
    requireArea("primarySales");
    const { wallet } = await verifySigned(request, "compliance.screenWallet");
    const sb = getSupabaseAdmin();
    await requireSanctionsClear(sb, {
      route: "launchpad buy (pre-check)",
      wallets: [{ wallet, role: "self" }],
    });
    await requireAcceptedTos(sb, wallet, "buying");
    return NextResponse.json({ ok: true, data: { clear: true } }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
