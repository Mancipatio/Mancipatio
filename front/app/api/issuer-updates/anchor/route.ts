// POST /api/issuer-updates/anchor — record the on-chain anchor of a
// PUBLISHED update: the Memo v2 transaction its issuer authority just sent
// (lib/document-anchor.ts, the Super Admin's document anchor reused with the
// issuer key as signer).
//
// Signed "issuerUpdates.anchor" — a session action, one of the accepted
// exceptions of lib/siws-session.ts: its only write is anchor_tx, set once,
// after the server re-read the transaction and verified it. params:
// { id, signature }.
//   - the update must be published (a draft has nothing to anchor, a
//     withdrawn one is no longer served); an anchor is recorded once: the
//     same signature again answers the record (idempotent), another 409;
//   - requireProfileOwner: the signer is the issuer's on-chain authority now;
//   - the memo must be exactly "<manci-update:id> sha256:<digest>", reference
//     and digest recomputed HERE from the stored row and its documents
//     (lib/server/issuer-updates issuerUpdateDigest), never taken from the
//     caller; documentAnchorEvidence checks the transaction succeeded, is
//     signed by the session wallet alone as fee payer, and holds that one
//     memo (besides compute budget and the wallet's own Lighthouse guards);
//   - only a FINALIZED transaction is recorded: a confirmed one answers 503
//     starting with DOCUMENT_ANCHOR_NOT_YET (the page waits and posts again).
// Recording an on-chain fact: open in KYC-only mode (the page offers no new
// anchor while issuance is paused).
import { NextResponse } from "next/server";
import { isSignature } from "@solana/kit";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { requireProfileOwner } from "@/lib/server/profile-read";
import { anchorNotYetError, readAnchorTransaction } from "@/lib/server/document-anchor";
import { DocumentAnchorEvidenceError, documentAnchorEvidence } from "@/lib/document-anchor";
import { issuerUpdateAnchorReference, type IssuerUpdateRecord } from "@/lib/issuer-updates";
import {
  ISSUER_ANCHOR_SIGNER_ROLE,
  UPDATES_TABLE,
  issuerUpdateDigest,
  loadDocuments,
  loadUpdate,
  readUuid,
  recordOf,
  unavailable,
} from "@/lib/server/issuer-updates";

// Two chain reads of up to 12 s each (finalized, then confirmed) and the writes.
export const maxDuration = 60;

const inFlight = new Set<string>();

export async function POST(request: Request) {
  let claimed: string | null = null;
  try {
    const { wallet, params } = await verifySigned(request, "issuerUpdates.anchor");
    const id = readUuid(params.id);
    const signature = typeof params.signature === "string" ? params.signature : "";
    if (!isSignature(signature)) throw new SiwsError(400, "A valid transaction signature is required");

    const sb = getSupabaseAdmin(AbortSignal.timeout(30_000));
    const answer = (update: IssuerUpdateRecord, duplicate: boolean) =>
      NextResponse.json({ ok: true, data: { update, duplicate } }, { headers: { "Cache-Control": "private, no-store" } });
    const update = await loadUpdate(sb, id);
    if (!update) throw new SiwsError(404, "Update not found");
    await requireProfileOwner(wallet, update.issuer_pda, "issuer");
    if (update.anchor_tx === signature) return answer(await recordOf(sb, id), true);
    if (update.anchor_tx) throw new SiwsError(409, "This update is already anchored by another transaction");
    if (update.status !== "published") throw new SiwsError(409, "Only a published update can be anchored");
    if (inFlight.has(signature)) throw new SiwsError(409, "This anchor is being recorded — try again in a moment");
    inFlight.add(signature);
    claimed = signature;

    const reference = issuerUpdateAnchorReference(id);
    const sha256 = issuerUpdateDigest(update, (await loadDocuments(sb, [id])).get(id) ?? []);
    const read = await readAnchorTransaction(signature);
    if (!read) throw anchorNotYetError(false);
    try {
      documentAnchorEvidence(read.tx, { signature, wallet, reference, sha256, signerRole: ISSUER_ANCHOR_SIGNER_ROLE });
    } catch (err) {
      if (err instanceof DocumentAnchorEvidenceError) throw new SiwsError(400, `Not recorded: ${err.message}`);
      throw err;
    }
    // A confirmed block can still be dropped on a minority fork: wait for finalized.
    if (read.commitment !== "finalized") throw anchorNotYetError(true);

    const { data, error } = await sb.from(UPDATES_TABLE).update({ anchor_tx: signature })
      .eq("network", detectNetwork()).eq("id", id).eq("status", "published").is("anchor_tx", null)
      .select("id").maybeSingle();
    if (error) unavailable();
    if (!data) {
      // Recorded (or withdrawn) by another request while the chain was read.
      const now = await recordOf(sb, id);
      if (now.anchor_tx === signature) return answer(now, true);
      throw new SiwsError(409, now.anchor_tx ? "This update is already anchored by another transaction" : "This update is no longer published");
    }
    return answer(await recordOf(sb, id), false);
  } catch (err) {
    return siwsErrorResponse(err);
  } finally {
    if (claimed) inFlight.delete(claimed);
  }
}
