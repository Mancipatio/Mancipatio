// POST /api/launchpad/commit — investor soft-commitment (Startup / SAFE path).
//
// Signed route: the SIWS-verified wallet IS the committing investor. The
// client passes investor_wallet redundantly and the server requires equality —
// nobody can record a commitment on someone else's behalf.
//
// NO KYC REQUIRED (product policy 2026-09-23): buying tokens — including a
// soft commitment to a raise — does not require identity verification; KYC
// is required only when tokens are converted into company equity
// (/api/conversion/create) or redeemed for a physical good
// (/api/delivery/create). The one compliance screen kept here is
// refuseSuspendedClient: a wallet whose dossier compliance has SUSPENDED
// (sanctions / fraud / investigation — only compliance can lift it) is still
// refused — "no KYC for buying" must not mean "compliance decisions are
// ignored for buying". A rejected KYC application is not a sanction and is
// not refused (see lib/server/kyc-gate.ts). A KycGated class keeps its
// passport requirement on-chain (the buy/settlement legs re-check the
// receiver).
//
// Pledges from wallets without a live verification are recorded, but the
// PUBLIC progress figures (commitment_totals, migration 0061) count only
// pledges whose wallet resolves to a live verified dossier and report the
// rest separately — a free SIWS signature from a throwaway wallet must not
// be able to push a raise to "100% pledged".
// Inserts a `pending` commitments row and returns its id.
//
// Client wrapper: createCommitment() in lib/launchpad.ts ("launchpad.commit").

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { refuseSuspendedClient } from "@/lib/server/kyc-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { publishedSaleDocument } from "@/lib/server/sale-document";
import {
  BASE58_RE,
  enforceSaleAmountCap,
  requireLiveSale,
  validateAmount,
} from "../_lib";

export async function POST(request: Request) {
  try {
    const signedCopy=request.clone();
    const { wallet, params } = await verifySigned(request, "launchpad.commit");

    // Compliance screen, not a KYC gate: no client profile or KYC is needed
    // to commit; only a suspended dossier is refused (see header).
    const sb = getSupabaseAdmin();
    await refuseSuspendedClient(sb, wallet, "committing to a raise");

    const salePubkey =
      typeof params.sale_pubkey === "string" ? params.sale_pubkey.trim() : "";
    if (!BASE58_RE.test(salePubkey)) {
      throw new SiwsError(400, "sale_pubkey must be a base58 address");
    }
    const investorWallet =
      typeof params.investor_wallet === "string"
        ? params.investor_wallet.trim()
        : "";
    if (investorWallet !== wallet) {
      throw new SiwsError(
        403,
        "Commitments can only be recorded for the signing wallet",
      );
    }
    const amount = validateAmount(params.amount);

    // The sale must be a real on-chain Sale (base58 shape is not enough —
    // otherwise anyone can seed commitments under arbitrary sale keys), and a
    // single commitment may not exceed the sale's raise target.
    await requireLiveSale(salePubkey);
    await enforceSaleAmountCap(salePubkey, amount);
    const terms=await publishedSaleDocument(salePubkey);
    const accepted=params.document_terms as {versionId?:unknown;sha256?:unknown}|null;
    if(!accepted || accepted.versionId !== terms.versionId || accepted.sha256 !== terms.sha256) throw new SiwsError(409,"Investment document changed or was not accepted. Review the current verified version before committing");
    const acceptance=await signedCopy.json();
    if(JSON.stringify(acceptance).length > 16_000) throw new SiwsError(400,"Commitment acceptance payload too large");

    const { data, error } = await sb.rpc("record_soft_commitment", {
      p_network: detectNetwork(),p_sale: salePubkey,p_wallet: wallet,p_amount: amount,
      p_document:terms.versionId,p_acceptance:acceptance,
    });
    if (error || !data) {
      if(error?.code === "23505") throw new SiwsError(409,"An active pledge with different terms already exists. Review it before committing again");
      console.error(
        "[api/launchpad/commit] insert failed:",
        error?.message ?? "no row",
      );
      throw new SiwsError(500, "Commitment write failed");
    }

    return NextResponse.json({ ok: true, data: { id: data as string } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
