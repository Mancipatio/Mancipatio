// POST /api/otc/create — a party requests an OTC escrow contract.
// Signed (SIWS). The signing wallet must be one of the two parties
// (buyer-initiated OR seller-initiated — a listing owner may request escrow
// against an interested buyer wallet), and requested_by is always stamped
// with the VERIFIED wallet, never taken from the payload.
//
// NO KYC REQUIRED (product policy 2026-09-23): OTC trading does not require
// identity verification — only conversion into company equity and physical
// delivery do. This is safe for KycGated classes too: the escrow's
// EscrowMarker only exempts the ROUTING legs from the transfer hook, and
// asset_registry::settle_otc_deal re-derives the buyer's receiver KYC
// on-chain (util::require_receiver_kyc), so a KycGated deal cannot settle
// to a wallet without a valid passport whatever this route accepts.
//
// Compliance screen kept (refuseSuspendedClient): the platform mediates this
// deal (an admin opens the escrow), so it refuses a request when EITHER
// party's dossier has been SUSPENDED by compliance — a sanctions / fraud /
// investigation decision, not missing KYC. The counterparty refusal is
// generic and does not name the status. The screen is repeated right before
// the escrow is opened (/api/otc/admin-screen, called by the admin OTC page),
// because a party can be suspended while the request waits in the queue.
//
// On-chain request checks (now that any signing wallet may file a request,
// not only a verified client): the payment mint must pass the plain-payment
// rule (and, on mainnet, the allowlist), the share class must be the real
// ShareClass behind `mint`, and the seller must hold at least `amount` units
// — so the admin queue only receives deals that can actually be funded. All
// fail closed (503) on RPC trouble, as in /api/resell/create.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { refuseSuspendedClient } from "@/lib/server/kyc-gate";
import {
  getToken2022Balance,
  verifyShareClassMint,
} from "@/lib/server/token-holdings";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { assertAllowedPaymentMint, paymentMintInfo } from "@/lib/server/payment-mint";
import type { Address } from "@solana/kit";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "otc.create");

    // Compliance screen, not a KYC gate: no client profile or KYC is needed
    // to request an escrow; only suspended dossiers are refused (both
    // parties — see header). The counterparty check runs after the party
    // validation below.
    const sb = getSupabaseAdmin();
    await refuseSuspendedClient(sb, wallet, "requesting an OTC escrow");

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
    // The buyer pays in this mint when the escrow opens (an entry path): on
    // mainnet the allowlist here, the plain-payment rule with the on-chain
    // checks below (Talas 4.2 §3.3).
    const network = detectNetwork();
    assertAllowedPaymentMint(network, paymentMint);

    // The other party of a platform-mediated deal gets the same suspension
    // screen. Generic copy: the requester is not told the counterparty's
    // compliance status.
    const counterparty = wallet === sellerWallet ? buyerWallet : sellerWallet;
    try {
      await refuseSuspendedClient(sb, counterparty, "trading");
    } catch (err) {
      if (err instanceof SiwsError && err.status === 403) {
        throw new SiwsError(
          403,
          "This OTC request cannot be accepted for the counterparty wallet — contact the compliance team.",
        );
      }
      throw err;
    }

    // On-chain request checks (see header) — after the cheap DB screens.
    await paymentMintInfo(paymentMint as Address, network);
    await verifyShareClassMint(shareClassPda, mint);
    const sellerBalance = await getToken2022Balance(sellerWallet, mint);
    if (BigInt(amount) > sellerBalance) {
      throw new SiwsError(
        400,
        "The seller wallet does not hold enough units of this token for this deal",
      );
    }

    const { data, error } = await sb
      .from("otc_requests")
      .insert({
        network,
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
