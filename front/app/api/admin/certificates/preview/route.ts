// POST /api/admin/certificates/preview — what a new certificate would say,
// before a number is spent: the chain facts (read now, finalized), the
// admin form's prefill (company details and scale: the last certificate of
// the asset, else the tokenization record, the issuer profile or the SPV),
// and the payload as it would read with a placeholder number. Writes
// nothing. Signed session read ("certificates.preview") + requireAdmin.
//
// params: { kind, share_class, wallet?, company?, units_for_100_percent?,
//           holder_name?, holder_id_number?, evidence? } (as /create; each
//           company field and the scale may be left empty: prefilled).
// A missing or invalid company detail or scale is not an error here: the
// answer carries payload null and `problem` saying what is missing. A
// wrong share class, wallet or evidence transaction is (400), and an RPC
// that cannot answer is a 503.
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { readCertificateChainFacts, readCertificateEvidence, readCertificatePrefill } from "@/lib/server/certificates";
import {
  CertificateInputError,
  buildCertificatePayload,
  certificateTokenSymbol,
  parseCertificateRequest,
  previewCertificateNumber,
  previewCompany,
  previewScale,
  type CertificatePayload,
  type CertificatePreview,
  type CertificateRequest,
} from "@/lib/certificates/payload";
import { CanonicalJsonError, canonicalJson } from "@/lib/certificates/canonical";
import { CERTIFICATE_ACTIONS } from "@/lib/certificates/routes";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

// Up to four chain reads of 12 s each (share class, asset, balance or
// supply, evidence statuses) on a slow RPC.
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, CERTIFICATE_ACTIONS.preview);
    await requireAdmin(wallet);
    let input: CertificateRequest;
    try {
      input = parseCertificateRequest(params, false);
    } catch (err) {
      if (err instanceof CertificateInputError) throw new SiwsError(400, err.message);
      throw err;
    }
    const network = detectNetwork();
    const sb = getSupabaseAdmin();
    const chain = await readCertificateChainFacts(input);
    const [prefill, evidence] = await Promise.all([
      readCertificatePrefill(sb, network, chain),
      readCertificateEvidence(input.evidence),
    ]);

    let payload: CertificatePayload | null = null;
    let problem: string | null = null;
    try {
      // What was typed wins field by field; the prefill fills the rest.
      const company = previewCompany(params.company, prefill.company);
      const scale = previewScale(params.units_for_100_percent, prefill.units_for_100_percent);
      const issuedAt = new Date();
      payload = buildCertificatePayload({
        network,
        number: previewCertificateNumber(issuedAt),
        kind: input.kind,
        issuedAt,
        // Never hashed: the draft gets its own random salt.
        salt: "0".repeat(32),
        company,
        unitsFor100Percent: scale,
        holder: input.wallet ? { wallet: input.wallet, name: input.holderName, idNumber: input.holderIdNumber } : null,
        evidence,
        chain,
        signer: wallet,
      });
      // What create will hash must encode: say so here rather than at creation.
      canonicalJson(payload);
    } catch (err) {
      if (err instanceof CertificateInputError) problem = err.message;
      else if (err instanceof CanonicalJsonError) problem = `This certificate cannot be encoded: ${err.message}`;
      else throw err;
      payload = null;
    }

    const data: CertificatePreview = {
      facts: {
        asset_pda: chain.asset.address,
        asset_id: chain.asset.assetId,
        asset_name: chain.asset.name,
        symbol: certificateTokenSymbol(chain.asset.symbolPrefix, chain.shareClass.classIndex),
        issuer_pda: chain.asset.issuer,
        share_class_pda: chain.shareClass.address,
        class_index: chain.shareClass.classIndex,
        mint: chain.shareClass.mint,
        max_supply: chain.shareClass.maxSupply === null ? null : chain.shareClass.maxSupply.toString(),
        lifetime_minted: chain.shareClass.lifetimeMinted.toString(),
        holding: chain.holding ? { units: chain.holding.units.toString(), slot: chain.holding.slot.toString() } : null,
        supply: chain.supply ? { circulating: chain.supply.circulating.toString(), slot: chain.supply.slot.toString() } : null,
      },
      prefill,
      payload,
      problem,
    };
    return NextResponse.json({ ok: true, data }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
