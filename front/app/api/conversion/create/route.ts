// POST /api/conversion/create — holder submits an ownership-conversion
// request (a share class with an on-chain conversion target → off-chain
// right). Signed (SIWS): the request is created for the SIGNING wallet only,
// and the server re-checks the KYC gate (wallet must belong to a KYC-verified
// client) instead of trusting the client-side eligibility check. Mirror of
// /api/delivery/create.
//
// ON-CHAIN VERIFICATION (fail closed): the claimed share class must exist and
// own the claimed mint; the stored asset_pda / asset_label are DERIVED from
// the on-chain records (holder input is ignored — the admin queue acts on the
// label, so a spoofed "Premium Tower A" against a cheap class's PDAs must be
// impossible); the share class must carry a conversion target
// (`convertible_to`, set jointly by platform + issuer — category is NOT the
// gate, so convertible revenue share works too); and the signer must
// actually hold the requested amount.
//
// Compliance, as on /api/otc/create: the signing wallet is screened against
// the sanctions lists (lib/server/sanctions.ts: a hit refuses with 403 and
// raises a compliance alert; on mainnet a list that cannot answer refuses
// with 503, fail closed), after the request itself is valid and before any
// chain read. A verified dossier does not replace the screen: a wallet can
// be listed after its dossier was verified. On mainnet the wallet must also
// have accepted the Terms in force (lib/server/tos-gate.ts: 409 without an
// acceptance, 503 when it cannot be checked), checked last, right before
// the write.

import { NextResponse } from "next/server";
import { requireModule } from "@/lib/server/feature-gate";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import {
  getToken2022Balance,
  resolveShareClassAssetFacts,
} from "@/lib/server/token-holdings";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { requireVerifiedClient } from "@/lib/server/kyc-gate";
import { requireSanctionsClear } from "@/lib/server/sanctions";
import { requireAcceptedTos } from "@/lib/server/tos-gate";
import { detectNetwork } from "@/lib/network";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function POST(request: Request) {
  try {
    // Pilot scope (lib/features.ts): an entry route of the custodyConversion module.
    requireModule("custodyConversion");
    const { wallet, params } = await verifySigned(request, "conversion.create");

    // Server-side KYC gate — converting tokens into company equity is one of
    // the two points where KYC is REQUIRED (policy 2026-09-23 — buying and
    // trading are not). The shared helper is fail-closed on duplicate client
    // rows (a terminal suspended/rejected row wins over an older verified
    // one), which an inline "oldest match wins" lookup was not.
    const sb = getSupabaseAdmin();
    const { clientId } = await requireVerifiedClient(
      sb,
      wallet,
      "requesting a conversion",
    );

    // Manual param narrowing (no zod). asset_pda / asset_label from the
    // client are DELIBERATELY ignored — both are derived on-chain below.
    const shareClassPda =
      typeof params.share_class_pda === "string" ? params.share_class_pda : "";
    const mint = typeof params.mint === "string" ? params.mint : "";
    const amount = typeof params.amount === "number" ? params.amount : NaN;
    const contact =
      typeof params.contact === "string" ? params.contact.trim() : "";
    const note = typeof params.note === "string" ? params.note.trim() : "";

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
    if (contact.length === 0 || contact.length > 300) {
      throw new SiwsError(400, "contact must be 1–300 characters");
    }
    if (note.length > 4000) {
      throw new SiwsError(400, "note must be at most 4000 characters");
    }

    // Sanctions screen of the signing wallet (see header), before any chain
    // work.
    await requireSanctionsClear(sb, {
      route: "conversion/create",
      wallets: [{ wallet, role: "self" }],
    });

    // On-chain resolution — verifies mint ↔ share class and derives the
    // label/asset PDA from the chain (throws 400/503; fail closed).
    const facts = await resolveShareClassAssetFacts(shareClassPda, mint);
    // Convertibility is gated on the ON-CHAIN conversion target recorded by
    // `set_convertible_to` (platform + issuer double gate) — not on the
    // asset's category. This is what admits convertible revenue-share
    // structures (v2 doc §5.2.11) and refuses classes whose conversion
    // target was never configured, whatever the category claims.
    if (!facts.convertibleTo) {
      throw new SiwsError(
        400,
        "This share class has no conversion target recorded on-chain — the platform and the issuer must first set one (set_convertible_to)",
      );
    }

    // The signer must actually hold what they ask to convert (503 on RPC
    // trouble — never treat "unverifiable" as "has balance").
    const balance = await getToken2022Balance(wallet, mint);
    if (BigInt(amount) > balance) {
      throw new SiwsError(
        400,
        `Amount exceeds your on-chain balance (${balance.toString()} units)`,
      );
    }

    // Mainnet: the requesting wallet must have accepted the Terms in force —
    // checked last, right before the write (a no-op on test networks).
    await requireAcceptedTos(sb, wallet, "requesting a conversion");

    const { data, error } = await sb
      .from("conversion_requests")
      .insert({
        network: detectNetwork(),
        holder_wallet: wallet,
        client_id: clientId,
        share_class_pda: shareClassPda,
        mint,
        asset_pda: facts.assetPda,
        asset_label: facts.assetLabel.slice(0, 300),
        amount,
        contact,
        note,
      })
      .select("id")
      .single();
    if (error || !data) {
      console.error("[api/conversion/create] insert failed:", error?.message);
      throw new SiwsError(500, "Could not save the conversion request");
    }

    return NextResponse.json({ ok: true, data: { id: data.id as string } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
