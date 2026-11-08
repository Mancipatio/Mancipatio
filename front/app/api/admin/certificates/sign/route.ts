// POST /api/admin/certificates/sign — record the signer's signature of a
// draft certificate, which makes it a certificate (public on
// /certificates/verify from then on).
//
// The browser asks the wallet to sign the certificate's message
// (lib/certificates/payload.ts certificateMessage: "Manci certificate v1",
// the number, the SHA-256 of the stored canonical payload) with the SIWS
// signing helper, and posts the signature here. The server rebuilds the
// message from the STORED row (never from the request), re-hashes the stored
// payload, and verifies the Ed25519 signature by the draft's signer over the
// byte strings SIWS accepts for that text (raw, or a Solana off-chain
// message for a Ledger: lib/certificates/signature.ts) before it stores the
// signature and the format it covers. The database moves draft -> signed
// only while the row is still a draft with that payload (certificates_guard).
//
// Signed "certificates.sign", a session action (an accepted exception in
// lib/siws-session.ts): its only write is the signature, and only after the
// server verified that the session wallet itself signed exactly this
// certificate, so holding the session cookie lets one record nothing that
// wallet did not sign. requireSuperAdmin (signing is the operator's act, as
// creating is), and the session wallet must be the signer the draft names
// (its creator). Refused during maintenance (lib/maintenance.ts): the Super
// Admin signs again afterwards (the same message gives the same signature).
//
// params: { id, signature (base58, 64 bytes), signature_format? (a hint:
//           "raw" | "offchain-v0" | "offchain-v0-legacy"; every accepted
//           format is tried) }
// Idempotent: posting the stored signature again answers the certificate.
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireSuperAdmin } from "@/lib/server/admin-gate";
import {
  auditCertificate,
  certificateDetail,
  certificateIdParam,
  moveCertificate,
  readCertificate,
} from "@/lib/server/certificates";
import { sha256HexOfText } from "@/lib/certificates/canonical";
import { certificateMessage } from "@/lib/certificates/payload";
import { certificateSignatureFormat, signatureFromBase58 } from "@/lib/certificates/signature";
import { CERTIFICATE_ACTIONS } from "@/lib/certificates/routes";
import { isSiwsSignatureFormat, type SiwsSignatureFormat } from "@/lib/siws-offchain";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(request, CERTIFICATE_ACTIONS.sign);
    await requireSuperAdmin(wallet);
    const id = certificateIdParam(params);
    const signature = typeof params.signature === "string" ? params.signature.trim() : "";
    if (!signatureFromBase58(signature)) throw new SiwsError(400, "A 64-byte Ed25519 signature in base58 is required");
    const hint: SiwsSignatureFormat = isSiwsSignatureFormat(params.signature_format) ? params.signature_format : "raw";

    const sb = getSupabaseAdmin();
    const network = detectNetwork();
    const row = await readCertificate(sb, network, id);
    if (!row) throw new SiwsError(404, "No certificate with this id on this network");
    const answer = (stored: typeof row) =>
      NextResponse.json({ ok: true, data: certificateDetail(stored) }, { headers: { "Cache-Control": "private, no-store" } });
    if (row.status !== "draft") {
      if (row.status !== "revoked" && row.signature === signature) return answer(row);
      throw new SiwsError(409, `This certificate is ${row.status === "revoked" ? "revoked" : "already signed"}`);
    }
    if (row.signer !== wallet) {
      throw new SiwsError(403, `This draft names ${row.signer} as its signer: connect that wallet to sign it`);
    }
    // The stored hash is the hash of the stored bytes (the database checks it too).
    if ((await sha256HexOfText(row.payload_canonical)) !== row.payload_sha256) {
      console.error("[api/admin/certificates/sign] stored hash does not match the stored payload:", row.id);
      throw new SiwsError(500, "This certificate's stored payload does not match its hash");
    }

    let format: SiwsSignatureFormat | null;
    try {
      format = await certificateSignatureFormat(certificateMessage(row.number, row.payload_sha256), wallet, signature, hint);
    } catch {
      throw new SiwsError(503, "Signature verification unavailable — try again");
    }
    if (!format) throw new SiwsError(400, "This signature is not the signer's signature of this certificate");

    const moved = await moveCertificate(sb, network, id, "draft", { status: "signed", signature, signature_format: format });
    if (!moved) {
      // Moved meanwhile (another tab, a double click): the same signature is a duplicate.
      const now = await readCertificate(sb, network, id);
      if (now && now.status !== "revoked" && now.signature === signature) return answer(now);
      throw new SiwsError(409, "This certificate changed meanwhile — reload it");
    }
    await auditCertificate(sb, {
      ixName: "certificate_sign",
      wallet,
      via,
      row: moved,
      reason: `Certificate ${moved.number} signed (SHA-256 ${moved.payload_sha256}, ${format})`,
    });
    return answer(moved);
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
