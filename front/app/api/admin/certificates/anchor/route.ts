// POST /api/admin/certificates/anchor — attach the on-chain anchor to a
// signed certificate.
//
// The anchor itself is a document anchor (lib/document-anchor.ts): the Super
// Admin's wallet sends one Memo v2 transaction "<number> sha256:<hash>"
// (from the certificate page, or Admin → Platform → Anchor a document), and
// /api/admin/document-anchor records it in the audit log only after it read
// the transaction FINALIZED from the server RPC and verified it (signed by
// Platform.admin alone, exactly that memo). This route takes only such a
// recorded anchor (lib/server/document-anchor.ts findAnchorRecord /
// findAnchorRecordsForReference, which accept rows the record route wrote
// and nothing else), whose reference is the certificate's number and whose
// hash is the certificate's payload_sha256, and stores its transaction,
// slot and block time: signed -> anchored (certificates_guard).
//
// Signed "certificates.anchor", a session action (an accepted exception in
// lib/siws-session.ts): its only write is the anchor, which the chain
// already shows and the record route already verified; holding the session
// cookie lets one attach nothing else. requireSuperAdmin: the Super Admin
// sends the memo, and anchoring stays the operator's act end to end, like
// creating and signing. Refused during maintenance (lib/maintenance.ts).
//
// params: { id, signature? } — the anchor transaction; without it, the first
// recorded anchor of the number and hash is taken.
// Idempotent: the stored anchor again answers the certificate.
import { NextResponse } from "next/server";
import { isSignature } from "@solana/kit";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireSuperAdmin } from "@/lib/server/admin-gate";
import {
  auditCertificate,
  certificateDetail,
  certificateIdParam,
  moveCertificate,
  readCertificate,
} from "@/lib/server/certificates";
import { findAnchorRecord, findAnchorRecordsForReference } from "@/lib/server/document-anchor";
import { CERTIFICATE_ACTIONS } from "@/lib/certificates/routes";
import type { DocumentAnchorRecord } from "@/lib/document-anchor";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(request, CERTIFICATE_ACTIONS.anchor);
    await requireSuperAdmin(wallet);
    const id = certificateIdParam(params);
    const given = typeof params.signature === "string" ? params.signature.trim() : "";
    if (given !== "" && !isSignature(given)) throw new SiwsError(400, "Enter the anchor transaction's signature (base58)");

    const sb = getSupabaseAdmin();
    const network = detectNetwork();
    const row = await readCertificate(sb, network, id);
    if (!row) throw new SiwsError(404, "No certificate with this id on this network");
    const answer = (stored: typeof row) =>
      NextResponse.json({ ok: true, data: certificateDetail(stored) }, { headers: { "Cache-Control": "private, no-store" } });
    if (row.status === "anchored" && (given === "" || row.anchor_tx === given)) return answer(row);
    if (row.status !== "signed") {
      throw new SiwsError(409, row.status === "draft" ? "Sign the certificate before you anchor it" : `This certificate is ${row.status}`);
    }

    const matches = (record: DocumentAnchorRecord) => record.reference === row.number && record.sha256 === row.payload_sha256;
    let anchor: DocumentAnchorRecord | null;
    if (given !== "") {
      anchor = await findAnchorRecord(sb, network, given);
      if (!anchor) {
        throw new SiwsError(409, "This transaction is not recorded as a document anchor yet: record it first (Anchor a document), then try again");
      }
      if (!matches(anchor)) throw new SiwsError(400, "This anchor is of another number or hash, not of this certificate");
    } else {
      anchor = (await findAnchorRecordsForReference(sb, network, row.number)).find(matches) ?? null;
      if (!anchor) throw new SiwsError(404, "No recorded anchor of this certificate's number and hash yet");
    }

    const moved = await moveCertificate(sb, network, id, "signed", {
      status: "anchored",
      anchor_tx: anchor.signature,
      anchor_slot: anchor.slot,
      anchor_block_time: anchor.blockTime === null ? null : new Date(anchor.blockTime * 1000).toISOString(),
    });
    if (!moved) {
      const now = await readCertificate(sb, network, id);
      if (now && now.status === "anchored" && now.anchor_tx === anchor.signature) return answer(now);
      throw new SiwsError(409, "This certificate changed meanwhile — reload it");
    }
    await auditCertificate(sb, {
      ixName: "certificate_anchor",
      wallet,
      via,
      row: moved,
      reason: `Certificate ${moved.number} anchored on chain`,
      txSignature: anchor.signature,
    });
    return answer(moved);
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
