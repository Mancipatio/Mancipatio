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
// (lib/server/sanctions.ts). The program remains the only on-chain control;
// a wallet that skips the UI is caught at the purchase record.
//
// Client wrapper: screenOwnWallet() in lib/compliance.ts.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { requireSanctionsClear } from "@/lib/server/sanctions";
import { getSupabaseAdmin } from "@/lib/supabase-server";

export async function POST(request: Request) {
  try {
    const { wallet } = await verifySigned(request, "compliance.screenWallet");
    await requireSanctionsClear(getSupabaseAdmin(), {
      route: "launchpad buy (pre-check)",
      wallets: [{ wallet, role: "self" }],
    });
    return NextResponse.json({ ok: true, data: { clear: true } }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
