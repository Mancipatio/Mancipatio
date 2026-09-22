// POST /api/delivery/create — holder submits a physical-delivery request.
// Signed (SIWS): the request is created for the SIGNING wallet only, and the
// server re-checks the KYC gate (wallet must belong to a KYC-verified client)
// instead of trusting the client-side eligibility check.
//
// ON-CHAIN VERIFICATION (fail closed): mirror of /api/conversion/create — the
// claimed share class must exist and own the claimed mint; the stored
// asset_pda / asset_label are DERIVED from the on-chain records (holder input
// is ignored — the custody queue and the physical-delivery courier act on the
// label, so a spoofed "Gold bar 1oz #5" against a cheap class's PDAs must be
// impossible); the asset must be a deliverable category (Commodity /
// PhysicalGood on-chain, or an admin-published profile reclassification); and
// the signer must actually hold the requested amount.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireVerifiedClient } from "@/lib/server/kyc-gate";
import {
  getToken2022Balance,
  resolveShareClassAssetFacts,
} from "@/lib/server/token-holdings";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "delivery.create");

    // Server-side KYC gate — the shared gate in lib/server/kyc-gate.ts (same
    // as conversion / vesting-series; one source of truth, no inline copy to
    // drift). Redeeming a token for a physical good is one of the two points
    // where KYC is REQUIRED (policy 2026-09-23 — buying and trading are not).
    // It also resolves the verified clients row id for the client_id stamp
    // on the insert below.
    const sb = getSupabaseAdmin();
    const { clientId } = await requireVerifiedClient(
      sb,
      wallet,
      "requesting delivery",
    );

    // Manual param narrowing (no zod). asset_pda / asset_label from the
    // client are DELIBERATELY ignored — both are derived on-chain below.
    const shareClassPda =
      typeof params.share_class_pda === "string" ? params.share_class_pda : "";
    const mint = typeof params.mint === "string" ? params.mint : "";
    const amount = typeof params.amount === "number" ? params.amount : NaN;
    const details =
      typeof params.delivery_details === "string"
        ? params.delivery_details.trim()
        : "";
    const contact =
      typeof params.contact === "string" ? params.contact.trim() : "";

    if (!BASE58_RE.test(shareClassPda)) {
      throw new SiwsError(400, "share_class_pda is not a valid address");
    }
    if (!BASE58_RE.test(mint)) {
      throw new SiwsError(400, "mint is not a valid address");
    }
    if (
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      amount > Number.MAX_SAFE_INTEGER
    ) {
      throw new SiwsError(400, "amount must be a positive integer");
    }
    if (details.length === 0 || details.length > 4000) {
      throw new SiwsError(400, "delivery_details must be 1–4000 characters");
    }
    if (contact.length === 0 || contact.length > 300) {
      throw new SiwsError(400, "contact must be 1–300 characters");
    }

    // On-chain resolution — verifies mint ↔ share class and derives the
    // label/asset PDA from the chain (throws 400/503; fail closed).
    const facts = await resolveShareClassAssetFacts(shareClassPda, mint);
    if (!facts.assetTypeDeliverable) {
      // Mirror the client rule: an admin-published asset profile may
      // reclassify an asset into a deliverable category.
      const { data: profile, error: profileErr } = await sb
        .from("asset_profiles")
        .select("category")
        .eq("asset_pda", facts.assetPda)
        .limit(1)
        .maybeSingle();
      if (profileErr) {
        throw new SiwsError(500, "Asset profile lookup failed");
      }
      const category = profile?.category;
      if (category !== "commodity" && category !== "physical") {
        throw new SiwsError(
          400,
          "Delivery is only available for commodity and physical-good assets",
        );
      }
    }

    // The signer must actually hold what they ask to deliver (503 on RPC
    // trouble — never treat "unverifiable" as "has balance").
    const balance = await getToken2022Balance(wallet, mint);
    if (BigInt(amount) > balance) {
      throw new SiwsError(
        400,
        `Amount exceeds your on-chain balance (${balance.toString()} units)`,
      );
    }

    const { data, error } = await sb
      .from("delivery_requests")
      .insert({
        network: detectNetwork(),
        holder_wallet: wallet,
        client_id: clientId,
        share_class_pda: shareClassPda,
        mint,
        asset_pda: facts.assetPda,
        asset_label: facts.assetLabel.slice(0, 300),
        amount,
        delivery_details: details,
        contact,
      })
      .select("id")
      .single();
    if (error || !data) {
      console.error("[api/delivery/create] insert failed:", error?.message);
      throw new SiwsError(500, "Could not save the delivery request");
    }

    return NextResponse.json({ ok: true, data: { id: data.id as string } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
