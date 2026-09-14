// POST /api/resell/create — holder posts a sell listing on the public board.
// Signed (SIWS). The server VERIFIES ON-CHAIN HOLDINGS before accepting:
//   - the signing wallet's Token-2022 balance of the mint must cover `amount`
//     (closes the spoof hole where anyone could list any amount of any mint);
//   - `share_class_pda` must be the real ShareClass account behind the mint
//     (it powers the resell board's "Request OTC escrow" funnel, which was
//     previously dead because the column was never populated).
// The server also re-checks the KYC gate (the listing wallet must belong to a
// KYC-verified client) — mirrors /api/delivery/create.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireVerifiedClient } from "@/lib/server/kyc-gate";
import {
  getToken2022Balance,
  verifyShareClassMint,
} from "@/lib/server/token-holdings";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CURRENCIES = new Set(["USDC", "USDT", "SOL", "EUR"]);

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "resell.create");

    // Server-side KYC gate — posting a resell listing is for onboarded,
    // KYC-verified clients only.
    const sb = getSupabaseAdmin();
    await requireVerifiedClient(sb, wallet, "posting a resell listing");

    const mint = typeof params.mint === "string" ? params.mint : "";
    const shareClassPda =
      typeof params.share_class_pda === "string" ? params.share_class_pda : "";
    const assetPda =
      typeof params.asset_pda === "string" ? params.asset_pda : null;
    const assetLabel =
      typeof params.asset_label === "string"
        ? params.asset_label.slice(0, 300)
        : "";
    const amount = typeof params.amount === "number" ? params.amount : NaN;
    const askPrice =
      params.ask_price === undefined || params.ask_price === null
        ? null
        : typeof params.ask_price === "number"
          ? params.ask_price
          : NaN;
    const askCurrency =
      typeof params.ask_currency === "string" ? params.ask_currency : "USDC";
    const note = typeof params.note === "string" ? params.note : "";
    const contact = typeof params.contact === "string" ? params.contact : "";

    if (!BASE58_RE.test(mint)) {
      throw new SiwsError(400, "mint is not a valid address");
    }
    if (!BASE58_RE.test(shareClassPda)) {
      throw new SiwsError(400, "share_class_pda is not a valid address");
    }
    if (assetPda !== null && !BASE58_RE.test(assetPda)) {
      throw new SiwsError(400, "asset_pda is not a valid address");
    }
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new SiwsError(400, "amount must be a positive integer");
    }
    if (askPrice !== null && (!Number.isFinite(askPrice) || askPrice <= 0)) {
      throw new SiwsError(400, "ask_price must be a positive number");
    }
    if (!CURRENCIES.has(askCurrency)) {
      throw new SiwsError(400, "ask_currency is not supported");
    }
    if (note.length > 1000) {
      throw new SiwsError(400, "note must be at most 1000 characters");
    }
    if (contact.length === 0 || contact.length > 300) {
      throw new SiwsError(400, "contact must be 1–300 characters");
    }

    // On-chain verification — both fail closed (503) on RPC trouble.
    const balance = await getToken2022Balance(wallet, mint);
    if (BigInt(amount) > balance) {
      throw new SiwsError(
        400,
        `Amount exceeds your on-chain balance (${balance.toString()} units)`,
      );
    }
    await verifyShareClassMint(shareClassPda, mint);

    const { data, error } = await sb
      .from("resell_listings")
      .insert({
        network: detectNetwork(),
        seller_wallet: wallet,
        mint,
        share_class_pda: shareClassPda,
        asset_pda: assetPda,
        asset_label: assetLabel,
        amount,
        ask_price: askPrice,
        ask_currency: askCurrency,
        note,
        contact,
      })
      .select("id")
      .single();
    if (error || !data) {
      console.error("[api/resell/create] insert failed:", error?.message);
      throw new SiwsError(500, "Could not post the listing");
    }

    return NextResponse.json({ ok: true, data: { id: data.id as string } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
