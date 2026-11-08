// POST /api/admin/certificates/create — create a certificate draft: read the
// chain now (finalized), build the payload with the admin's details,
// allocate the next number of this network and year, and store the canonical
// payload and its SHA-256 (migration 0087). The draft is not a certificate
// yet: nothing is public until its signer signs it (/sign).
//
// Signed "certificates.create" with a FRESH wallet signature (a write: it
// spends a number and names the session wallet as the certificate's signer)
// + requireAdmin.
//
// params: { kind: "holding" | "issuance", share_class, wallet (holding only),
//           company: { legal_name, registration_number, address },
//           units_for_100_percent, holder_name?, holder_id_number? (holding
//           only; personal data, typed for this certificate),
//           evidence?: [{ signature, note? }] (≤ 10, each finalized and
//           successful on this network) }
//
// Everything is validated, and the payload built once with a placeholder
// number, BEFORE a number is allocated, so a wrong input never spends one.
// A failure between the allocation and the insert leaves a gap in the
// numbering, never a repeated number. The issued_at in the payload and the
// year of its number come from the same server clock reading.
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import {
  allocateCertificateNumber,
  auditCertificate,
  certificateDetail,
  certificateSalt,
  insertCertificateDraft,
  readCertificateChainFacts,
  readCertificateEvidence,
} from "@/lib/server/certificates";
import { CanonicalJsonError, canonicalDigest, canonicalJson } from "@/lib/certificates/canonical";
import {
  CERTIFICATE_MAX_PAYLOAD_CHARS,
  CertificateInputError,
  buildCertificatePayload,
  parseCertificateRequest,
  previewCertificateNumber,
  type CertificatePayload,
  type CertificateRequest,
} from "@/lib/certificates/payload";
import { CERTIFICATE_ACTIONS } from "@/lib/certificates/routes";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

// Up to four chain reads of 12 s each, the allocation and the insert.
export const maxDuration = 60;

/** The real number may be two digits longer than the placeholder's four. */
const NUMBER_GROWTH = 2;

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(request, CERTIFICATE_ACTIONS.create);
    await requireAdmin(wallet);
    let input: CertificateRequest;
    try {
      input = parseCertificateRequest(params, true);
    } catch (err) {
      if (err instanceof CertificateInputError) throw new SiwsError(400, err.message);
      throw err;
    }
    const company = input.company;
    const scale = input.unitsFor100Percent;
    if (!company || scale === null) throw new SiwsError(400, "The company's details and the scale are required");

    const network = detectNetwork();
    const sb = getSupabaseAdmin();
    const chain = await readCertificateChainFacts(input);
    const evidence = await readCertificateEvidence(input.evidence);
    const issuedAt = new Date();
    const salt = certificateSalt();
    const build = (number: string): CertificatePayload =>
      buildCertificatePayload({
        network,
        number,
        kind: input.kind,
        issuedAt,
        salt,
        company,
        unitsFor100Percent: scale,
        holder: input.wallet ? { wallet: input.wallet, name: input.holderName, idNumber: input.holderIdNumber } : null,
        evidence,
        chain,
        signer: wallet,
      });
    try {
      const dryRun = canonicalJson(build(previewCertificateNumber(issuedAt)));
      if (dryRun.length + NUMBER_GROWTH > CERTIFICATE_MAX_PAYLOAD_CHARS) {
        throw new CertificateInputError("This certificate is too long: shorten the notes or the company's details.");
      }
    } catch (err) {
      if (err instanceof CertificateInputError) throw new SiwsError(400, err.message);
      // A value the canonical form refuses (lib/certificates/canonical.ts):
      // the inputs are cleaned first, so this names a fact that cannot be stated.
      if (err instanceof CanonicalJsonError) throw new SiwsError(400, `This certificate cannot be encoded: ${err.message}`);
      throw err;
    }

    const number = await allocateCertificateNumber(sb, issuedAt.getUTCFullYear());
    const { canonical, sha256 } = await canonicalDigest(build(number));
    const row = await insertCertificateDraft(sb, {
      network,
      number,
      kind: input.kind,
      asset_pda: chain.asset.address,
      share_class_pda: chain.shareClass.address,
      holder_wallet: input.wallet,
      payload_canonical: canonical,
      payload_sha256: sha256,
      signer: wallet,
      created_by: wallet,
    });
    await auditCertificate(sb, {
      ixName: "certificate_create",
      wallet,
      via,
      row,
      reason: `Certificate draft ${number} (${input.kind}) created`,
    });
    return NextResponse.json({ ok: true, data: certificateDetail(row) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
