// POST /api/otc/create — a party requests an OTC escrow contract.
// Signed (SIWS). The signing wallet must be one of the two parties
// (buyer-initiated OR seller-initiated — a listing owner may request escrow
// against an interested buyer wallet), and requested_by is always stamped
// with the VERIFIED wallet, never taken from the payload. The server also
// re-checks the KYC gate (the requesting wallet must belong to a KYC-verified
// client) — mirrors /api/delivery/create; the OTC settle leg is exempt from
// the on-chain receiver-KYC hook via its EscrowMarker, so the platform must
// vet the parties off-chain before the escrow exists.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireVerifiedClient } from "@/lib/server/kyc-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "otc.create");

    // Server-side KYC gate — requesting an OTC escrow is for onboarded,
    // KYC-verified clients only.
    const sb = getSupabaseAdmin();
    await requireVerifiedClient(sb, wallet, "requesting an OTC escrow");

    const shareClassPda =
      typeof params.share_class_pda === "string" ? params.share_class_pda : "";
    const mint = typeof params.mint === "string" ? params.mint : "";
    const assetLabel =
      typeof params.asset_label === "string"
        ? params.asset_label.slice(0, 300)
        : "";
    const sellerWallet =
      typeof params.seller_wallet === "string" ? params.seller_wallet : "";
    const buyerWallet =
      typeof params.buyer_wallet === "string" ? params.buyer_wallet : "";
    const amount = typeof params.amount === "number" ? params.amount : NaN;
    const price = typeof params.price === "number" ? params.price : NaN;
    const paymentMint =
      typeof params.payment_mint === "string" ? params.payment_mint : "";
    const expiresAt =
      typeof params.expires_at === "string" ? params.expires_at : null;

    if (!BASE58_RE.test(shareClassPda)) {
      throw new SiwsError(400, "share_class_pda is not a valid address");
    }
    if (!BASE58_RE.test(mint)) {
      throw new SiwsError(400, "mint is not a valid address");
    }
    if (!BASE58_RE.test(sellerWallet)) {
      throw new SiwsError(400, "seller_wallet is not a valid address");
    }
    if (!BASE58_RE.test(buyerWallet)) {
      throw new SiwsError(400, "buyer_wallet is not a valid address");
    }
    if (!BASE58_RE.test(paymentMint)) {
      throw new SiwsError(400, "payment_mint is not a valid address");
    }
    if (sellerWallet === buyerWallet) {
      throw new SiwsError(400, "Buyer and seller must be different wallets");
    }
    if (wallet !== sellerWallet && wallet !== buyerWallet) {
      throw new SiwsError(
        403,
        "The signing wallet must be the buyer or the seller of the deal",
      );
    }
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new SiwsError(400, "amount must be a positive integer");
    }
    if (!Number.isSafeInteger(price) || price <= 0) {
      throw new SiwsError(400, "price must be a positive integer");
    }
    if (expiresAt !== null && Number.isNaN(new Date(expiresAt).getTime())) {
      throw new SiwsError(400, "expires_at is not a valid timestamp");
    }

    const { data, error } = await sb
      .from("otc_requests")
      .insert({
        network: detectNetwork(),
        share_class_pda: shareClassPda,
        mint,
        asset_label: assetLabel,
        seller_wallet: sellerWallet,
        buyer_wallet: buyerWallet,
        amount,
        price,
        payment_mint: paymentMint,
        requested_by: wallet,
        expires_at: expiresAt,
      })
      .select("id")
      .single();
    if (error || !data) {
      console.error("[api/otc/create] insert failed:", error?.message);
      throw new SiwsError(500, "Could not submit the OTC request");
    }

    return NextResponse.json({ ok: true, data: { id: data.id as string } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
