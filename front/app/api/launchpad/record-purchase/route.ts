import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { transactionSignature } from "@/lib/server/chain-evidence";
import { enqueuePurchase, processPurchaseJob } from "@/lib/server/purchase-records";
import { reportSanctionsHits } from "@/lib/server/sanctions";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { BASE58_RE } from "../_lib";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "launchpad.recordPurchase");
    const sale = typeof params.sale_pubkey === "string" ? params.sale_pubkey.trim() : "";
    if (!BASE58_RE.test(sale)) throw new SiwsError(400, "sale_pubkey must be a base58 address");
    if (params.investor_wallet !== wallet) throw new SiwsError(403, "Only the buyer may record their purchase");
    const signature = transactionSignature(params.settled_tx);
    const instruction = params.instruction_index;
    if (instruction !== undefined && (typeof instruction !== "number" || !Number.isInteger(instruction) || instruction < 0 || instruction > 255)) {
      throw new SiwsError(400, "Invalid instruction index");
    }
    // Records an already authorized chain buy even if KYC expired afterwards.
    // No new spending permission is granted. Client amount is never trusted.
    // The record is never refused for the buyer's sanctions status: the buy
    // already landed, and the portfolio, the sale's totals and the ledger
    // later payouts and a clawback work from must match the chain.
    const job = await enqueuePurchase(wallet, sale, signature, instruction as number | undefined);
    let data: Awaited<ReturnType<typeof processPurchaseJob>>;
    try {
      data = await processPurchaseJob(job);
    } finally {
      // Sanctions (8.5): report-only here. A hit raises the compliance
      // alert WITH the transaction (blocklist + clawback per runbook); a list
      // that cannot answer on mainnet leaves the screen to the alarm worker,
      // which screens every finalized buy's signer and retries until the
      // list is usable (lib/server/onchain-screening.ts). Never throws.
      await reportSanctionsHits(getSupabaseAdmin(), {
        route: "launchpad/record-purchase",
        wallets: [{ wallet, role: "self" }],
        txSignature: signature,
      }).catch((err) => {
        console.error("[api/launchpad/record-purchase] sanctions report failed:", err instanceof Error ? err.message : String(err));
      });
    }
    return NextResponse.json({ ok: true, data }, { status: data.status === "pending" ? 202 : 200 });
  } catch (error) { return siwsErrorResponse(error); }
}
