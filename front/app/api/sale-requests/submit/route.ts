// POST /api/sale-requests/submit — the issuer asks for a public sale of its
// tokens (Distribute → Public sale; "saleRequests.submit", signed).
//
// Only the class's issuer authority (read on chain) may ask, for a KYB
// verified issuer, an active asset and an initialized mint. The server
// checks the terms against the chain — price above 0, a duration of 30, 90
// or 365 days, tokens within the room left (cap − created − Open sales −
// reserved treasury mints − live approvals not opened yet) — refuses while
// a sale of the class is approved or open, or a request is already waiting,
// and stores the request in the asset's private profile
// (fields.sale_request, lib/server/sale-requests), stamping who and when.
//
// In the same call it publishes the buyer document: a verified upload of
// this asset (whitepapers/<asset>/…, lib/server/document-versions), the
// whitepaper status "published" and the profile published — what the
// sale's document route requires before anyone can buy. An SSC-approved
// whitepaper is never replaced here (the operator manages that one).
//
// An archived asset (or an asset of an archived issuer) is refused (409):
// publishing the profile here would silently take the archive back, which
// only /api/archive/set does (with its reason and audit event). The write
// itself is conditional on the row not being archived meanwhile.
//
// Params: share_class, price_per_unit (USDC base units), tokens,
// duration_days (30 | 90 | 365), document { path, sha256 }.
// Client wrapper: submitSaleRequest() in lib/sale-requests.ts.

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { actorSourceOf, writeServerAudit } from "@/lib/server/audit";
import { requireDocumentVersion } from "@/lib/server/document-versions";
import { addressParam, u64Param } from "@/lib/server/sale-capacity";
import { USDC } from "@/lib/payment-mints";
import { docMatchesLegalHash, isSaleDuration, publicSaleReason, type SaleRequest } from "@/lib/public-sale";
import {
  assetDocumentPath,
  fieldsWithRequest,
  readRequestProfile,
  readSaleRoom,
  requestOutcomes,
  storedRequest,
} from "@/lib/server/sale-requests";
import { assertAllowedPaymentMint, shareClassChain } from "@/app/api/sale-approvals/_lib";
import { ARCHIVED_ASSET_REFUSAL, requireNotArchived } from "@/lib/server/archive";

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(request, "saleRequests.submit");
    const network = detectNetwork();
    const shareClass = addressParam(params.share_class, "share_class");
    const price = u64Param(params.price_per_unit, "price_per_unit", { positive: true });
    const tokens = u64Param(params.tokens, "tokens", { positive: true });
    const days = typeof params.duration_days === "string" ? Number(params.duration_days) : params.duration_days;
    if (!isSaleDuration(days)) throw new SiwsError(400, "duration_days must be 30, 90 or 365");
    const document = params.document as { path?: unknown; sha256?: unknown } | null;
    if (!document || typeof document !== "object" || typeof document.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(document.sha256)) {
      throw new SiwsError(400, "document { path, sha256 } is required");
    }

    // Who may ask: the class's issuer authority (on chain), for a verified issuer.
    const chain = await shareClassChain(shareClass);
    if (chain.authority !== wallet) throw new SiwsError(403, "Only the issuer's key may request a sale of its tokens");
    if (!chain.issuerVerified) throw new SiwsError(409, "The issuer is not KYB-verified");
    const sb = getSupabaseAdmin();
    // An archived asset is not offered again through a request (see header).
    await requireNotArchived(sb, chain.asset, chain.issuer);
    const usdc = USDC[network]?.mint;
    if (!usdc) throw new SiwsError(409, "There is no USDC on this network, so no public sale can be requested");
    assertAllowedPaymentMint(network, usdc);
    const path = assetDocumentPath(document.path, chain.asset);
    const version = await requireDocumentVersion("documents", path, document.sha256);

    const facts = await readSaleRoom(sb, shareClass, chain.asset);
    if (!facts.assetActive) throw new SiwsError(409, "The asset is not active yet: the operator activates it first");
    if (!facts.mintInitialized) throw new SiwsError(409, "The share class has no token mint yet");
    if (facts.openSales > 0) throw new SiwsError(409, "A sale of this class is open: end it before requesting another");
    if (facts.liveApprovals > 0) throw new SiwsError(409, "A sale of this class is already approved and waiting to be opened");
    if (facts.room !== null && tokens > facts.room) {
      throw new SiwsError(409, `Only ${facts.room.toLocaleString("en-US")} tokens can still be offered (the cap minus everything created, on sale or reserved)`);
    }

    const profile = await readRequestProfile(sb, chain.asset);
    if (!profile) throw new SiwsError(409, "Save the token's details first (the asset page needs its profile), then request the sale");
    // A request still "requested" blocks a new one until its sale opened (the ledger shows it consumed or closed);
    // the Open-sale refusal above then holds the next one until that sale is closed.
    const previous = storedRequest(profile);
    if (previous?.status === "requested") {
      const outcome = (await requestOutcomes(sb, [previous])).get(previous.id) ?? null;
      if (outcome === null || outcome === "approved") {
        throw new SiwsError(409, "A request is already waiting for the operator: withdraw it first to change it");
      }
    }
    if (profile.whitepaper_status === "ssc_approved" && profile.whitepaper_path !== version.path) {
      throw new SiwsError(409, "This asset's whitepaper is SSC-approved; the operator changes that document, not a sale request");
    }

    const now = new Date().toISOString();
    const saleRequest: SaleRequest = {
      v: 1,
      id: randomUUID(),
      share_class: shareClass,
      price_per_unit: price.toString(),
      payment_mint: usdc,
      tokens: tokens.toString(),
      duration_days: days,
      document: {
        path: version.path,
        sha256: version.sha256,
        version_id: version.id,
        matches_legal_doc: docMatchesLegalHash(version.sha256, facts.legalDocHash),
      },
      status: "requested",
      requested_by: wallet,
      requested_at: now,
    };
    const sameDocument = profile.whitepaper_path === version.path && !!profile.whitepaper_published_at;
    const { data: written, error } = await sb
      .from("asset_profiles")
      .update({
        fields: fieldsWithRequest(profile.fields, saleRequest),
        whitepaper_path: version.path,
        whitepaper_sha256: version.sha256,
        whitepaper_version_id: version.id,
        whitepaper_status: profile.whitepaper_status === "ssc_approved" ? "ssc_approved" : "published",
        whitepaper_published_at: sameDocument ? profile.whitepaper_published_at : now,
        is_published: true,
        status: "published",
      })
      .eq("network", network)
      .eq("asset_pda", chain.asset)
      // Archived since the check above: never published back.
      .neq("status", "archived")
      .select("asset_pda");
    if (error) {
      console.error("[api/sale-requests/submit] write failed:", error.message);
      throw new SiwsError(500, "Could not save the request");
    }
    if (!Array.isArray(written) || written.length === 0) throw new SiwsError(409, ARCHIVED_ASSET_REFUSAL);

    try {
      await writeServerAudit(sb, {
        ix_name: "sale_request_submit",
        category: "launchpad",
        actor_wallet: wallet,
        actor_source: actorSourceOf(via),
        reason: publicSaleReason(saleRequest),
        target_label: shareClass,
        metadata: {
          network,
          request_id: saleRequest.id,
          asset: chain.asset,
          price_per_unit: saleRequest.price_per_unit,
          tokens: saleRequest.tokens,
          duration_days: days,
          document_version_id: version.id,
          matches_legal_doc: saleRequest.document.matches_legal_doc,
        },
      });
    } catch (auditErr) {
      console.warn("[api/sale-requests/submit] audit event not written:", auditErr instanceof Error ? auditErr.message : String(auditErr));
    }

    return NextResponse.json({ ok: true, data: { request: saleRequest, asset: chain.asset } }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
