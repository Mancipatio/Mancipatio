// POST /api/admin/document-anchor — record a document anchor the Super Admin
// just sent (lib/document-anchor.ts) in the audit log.
//
// Signed "admin.documentAnchorRecord" (a session action: the send's wallet
// check has just signed the Super Admin in, so no second prompt) and
// requireSuperAdmin: the session wallet must be the on-chain Platform.admin.
//
// params: { signature, reference, sha256 } — what the page sent.
//
// The transaction is read from the server RPC (finalized, else confirmed;
// 503 starting with DOCUMENT_ANCHOR_NOT_YET while it has neither) and must
// have succeeded, be signed by the session wallet alone as fee payer and
// hold exactly one Memo v2 instruction, signed by that wallet, whose text is
// exactly "<reference> sha256:<sha256>" (documentAnchorEvidence). Then one
// server audit row: category "operator", ix_name "document_anchor",
// target_label = reference, tx_signature = signature, metadata = reference,
// sha256, memo, slot, block_time, commitment.
//
// Idempotent per signature: a signature already recorded on this network
// answers its row (duplicate: true) without a second row or a chain read; the
// same signature with another reference or hash is refused (409). Two
// requests for one signature at the same moment on one instance: the second
// is refused (409, retry); across instances the check runs again right
// before the insert.
import { NextResponse } from "next/server";
import { isSignature } from "@solana/kit";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireSuperAdmin } from "@/lib/server/admin-gate";
import { actorSourceOf, writeServerAudit } from "@/lib/server/audit";
import { fetchAnchorTransaction, findAnchorRecord } from "@/lib/server/document-anchor";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import {
  DOCUMENT_ANCHOR_AUDIT,
  DOCUMENT_ANCHOR_RECORD_ACTION,
  DOCUMENT_ANCHOR_REFERENCE_PATTERN,
  DOCUMENT_ANCHOR_SHA256_PATTERN,
  DocumentAnchorEvidenceError,
  MEMO_PROGRAM_ADDRESS,
  documentAnchorEvidence,
  type DocumentAnchorRecord,
} from "@/lib/document-anchor";

const inFlight = new Set<string>();

function sameAnchor(record: DocumentAnchorRecord, reference: string, sha256: string): boolean {
  return record.reference === reference && record.sha256 === sha256;
}

export async function POST(request: Request) {
  let claimed: string | null = null;
  try {
    const { wallet, params, via } = await verifySigned(request, DOCUMENT_ANCHOR_RECORD_ACTION);
    await requireSuperAdmin(wallet);

    const signature = typeof params.signature === "string" ? params.signature : "";
    if (!isSignature(signature)) throw new SiwsError(400, "A valid transaction signature is required");
    const reference = typeof params.reference === "string" ? params.reference : "";
    if (!DOCUMENT_ANCHOR_REFERENCE_PATTERN.test(reference)) throw new SiwsError(400, "Invalid document reference");
    const sha256 = typeof params.sha256 === "string" ? params.sha256 : "";
    if (!DOCUMENT_ANCHOR_SHA256_PATTERN.test(sha256)) {
      throw new SiwsError(400, "The SHA-256 must be 64 lowercase hex characters");
    }

    const sb = getSupabaseAdmin();
    const network = detectNetwork();
    const answer = (record: DocumentAnchorRecord, duplicate: boolean) => {
      if (!sameAnchor(record, reference, sha256)) {
        throw new SiwsError(409, "This transaction is already recorded as another anchor");
      }
      return NextResponse.json({ ok: true, data: { ...record, duplicate } }, { headers: { "Cache-Control": "private, no-store" } });
    };

    const existing = await findAnchorRecord(sb, network, signature);
    if (existing) return answer(existing, true);
    if (inFlight.has(signature)) throw new SiwsError(409, "This anchor is being recorded — try again in a moment");
    inFlight.add(signature);
    claimed = signature;

    const { tx, commitment } = await fetchAnchorTransaction(signature);
    let evidence: ReturnType<typeof documentAnchorEvidence>;
    try {
      evidence = documentAnchorEvidence(tx, { signature, wallet, reference, sha256 });
    } catch (err) {
      if (err instanceof DocumentAnchorEvidenceError) throw new SiwsError(400, `Not recorded: ${err.message}`);
      throw err;
    }

    // Another instance may have recorded it while the chain was read.
    const raced = await findAnchorRecord(sb, network, signature);
    if (raced) return answer(raced, true);

    const blockTimeIso = evidence.blockTime === null ? null : new Date(evidence.blockTime * 1000).toISOString();
    const id = await writeServerAudit(sb, {
      ix_name: DOCUMENT_ANCHOR_AUDIT.ixName,
      category: DOCUMENT_ANCHOR_AUDIT.category,
      actor_wallet: wallet,
      actor_source: actorSourceOf(via),
      reason: `Document fingerprint anchored on chain: ${reference}`,
      target_label: reference,
      tx_signature: signature,
      status: "success",
      metadata: {
        network,
        reference,
        sha256,
        memo: evidence.memo,
        memo_program: MEMO_PROGRAM_ADDRESS,
        signer: evidence.signer,
        slot: evidence.slot,
        block_time: evidence.blockTime,
        block_time_iso: blockTimeIso,
        commitment,
        wallet_guard_instructions: evidence.walletGuardInstructions,
      },
    });

    const record: DocumentAnchorRecord = {
      id,
      reference,
      sha256,
      signature,
      signer: wallet,
      slot: evidence.slot,
      blockTime: evidence.blockTime,
      commitment,
      recordedAt: new Date().toISOString(),
    };
    return NextResponse.json({ ok: true, data: { ...record, duplicate: false } }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  } finally {
    if (claimed) inFlight.delete(claimed);
  }
}
