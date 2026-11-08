// POST /api/admin/certificates/revoke — revoke a certificate (or discard a
// draft) with a reason. Revoked is final (certificates_guard). The public
// page then answers "revoked" with the date for a certificate that was
// signed, and "not found" for a draft that never was; it never shows the
// reason, which is free text an admin typed and may name a person.
//
// An anchor stays on chain: revocation is recorded here, off chain.
//
// Signed "certificates.revoke" with a FRESH wallet signature + requireAdmin.
// params: { id, reason (4–500 characters) }
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import {
  auditCertificate,
  certificateDetail,
  certificateIdParam,
  moveCertificate,
  readCertificate,
} from "@/lib/server/certificates";
import { CertificateInputError, certificateText } from "@/lib/certificates/payload";
import { CERTIFICATE_ACTIONS } from "@/lib/certificates/routes";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(request, CERTIFICATE_ACTIONS.revoke);
    await requireAdmin(wallet);
    const id = certificateIdParam(params);
    let reason: string;
    try {
      reason = certificateText(params.reason, "The reason", 4, 500);
    } catch (err) {
      if (err instanceof CertificateInputError) throw new SiwsError(400, err.message);
      throw err;
    }

    const sb = getSupabaseAdmin();
    const network = detectNetwork();
    const row = await readCertificate(sb, network, id);
    if (!row) throw new SiwsError(404, "No certificate with this id on this network");
    if (row.status === "revoked") throw new SiwsError(409, "This certificate is already revoked");

    const moved = await moveCertificate(sb, network, id, row.status, { status: "revoked", revoked_by: wallet, revoke_reason: reason });
    if (!moved) throw new SiwsError(409, "This certificate changed meanwhile — reload it");
    await auditCertificate(sb, {
      ixName: "certificate_revoke",
      wallet,
      via,
      row: moved,
      reason: `Certificate ${moved.number} ${row.status === "draft" ? "discarded (draft)" : "revoked"}: ${reason}`,
    });
    return NextResponse.json({ ok: true, data: certificateDetail(moved) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
