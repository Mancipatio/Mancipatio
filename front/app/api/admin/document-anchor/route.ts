// POST /api/admin/document-anchor — record a document anchor the Super Admin
// just sent (lib/document-anchor.ts) in the audit log.
//
// Signed "admin.documentAnchorRecord" (a session action: the send's wallet
// check has just signed the Super Admin in, so no second prompt; see the
// exception noted in lib/siws-session.ts) and requireSuperAdmin: the session
// wallet must be the on-chain Platform.admin.
//
// params: { signature, reference, sha256 } — what the page sent.
//
// The transaction is read from the server RPC (finalized, else confirmed)
// and must have succeeded, be signed by the session wallet alone as fee
// payer and hold exactly one Memo v2 instruction, signed by that wallet,
// whose text is exactly "<reference> sha256:<sha256>"; besides it only
// compute-budget instructions and the wallet's own Lighthouse assertions
// (at most DOCUMENT_ANCHOR_MAX_WALLET_GUARDS, no inner calls) are allowed
// (documentAnchorEvidence). Only a FINALIZED transaction is recorded: a
// confirmed one is checked at once (a wrong anchor gets its 400 without
// waiting) and answered 503 starting with DOCUMENT_ANCHOR_NOT_YET, like one
// the node does not show at all; the page waits and posts again. Then one
// server audit row: category "operator", ix_name "document_anchor",
// target_label = reference, tx_signature = signature, metadata = reference,
// sha256, memo, slot, block_time, commitment ("finalized").
//
// Idempotent per signature: a signature already recorded on this network
// answers its row (duplicate: true) without a second row or a chain read; the
// same signature with another reference or hash is refused (409). The row id
// is derived from the network and the signature (documentAnchorAuditId), so
// two instances recording the same signature at once cannot both insert: the
// primary key refuses the second, which then answers the first one's row.
// On one instance a concurrent second request is refused at once (409, retry).
import { NextResponse } from "next/server";
import { isSignature } from "@solana/kit";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireSuperAdmin } from "@/lib/server/admin-gate";
import { ServerAuditRowExistsError, actorSourceOf, writeServerAudit } from "@/lib/server/audit";
import { anchorNotYetError, documentAnchorAuditId, findAnchorRecord, readAnchorTransaction } from "@/lib/server/document-anchor";
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

// Two chain reads of up to 12 s each (finalized, then confirmed), the audit
// reads and the insert: more than the default function duration on a slow
// RPC, and the page retries only the route's own JSON 503, not a platform 504.
export const maxDuration = 60;

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

    const read = await readAnchorTransaction(signature);
    if (!read) throw anchorNotYetError(false);
    const { tx, commitment } = read;
    let evidence: ReturnType<typeof documentAnchorEvidence>;
    try {
      evidence = documentAnchorEvidence(tx, { signature, wallet, reference, sha256 });
    } catch (err) {
      if (err instanceof DocumentAnchorEvidenceError) throw new SiwsError(400, `Not recorded: ${err.message}`);
      throw err;
    }
    // A confirmed block can still be dropped on a minority fork: the evidence
    // row waits for finalized (about 13 s more; the page retries).
    if (commitment !== "finalized") throw anchorNotYetError(true);

    // Another instance may have recorded it while the chain was read.
    const raced = await findAnchorRecord(sb, network, signature);
    if (raced) return answer(raced, true);

    const blockTimeIso = evidence.blockTime === null ? null : new Date(evidence.blockTime * 1000).toISOString();
    let id: string;
    try {
      id = await writeServerAudit(sb, {
        id: documentAnchorAuditId(network, signature),
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
    } catch (err) {
      if (err instanceof ServerAuditRowExistsError) {
        // Another instance inserted this anchor's row a moment ago.
        const winner = await findAnchorRecord(sb, network, signature);
        if (winner) return answer(winner, true);
        throw new SiwsError(409, "This anchor is being recorded — try again in a moment");
      }
      if (err instanceof SiwsError && err.status === 503) {
        // The shared message speaks of releases; here the memo is already on chain.
        throw new SiwsError(503, "Audit log unavailable — the anchor is on chain but not recorded yet; record it again");
      }
      throw err;
    }

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
