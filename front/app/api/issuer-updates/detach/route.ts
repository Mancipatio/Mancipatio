// POST /api/issuer-updates/detach — remove a document from a DRAFT (the
// verified file stays in the private bucket, content-addressed; attaching it
// again reuses it). KYC-only mode: part of composing, refused before the
// signature (requireArea). Signed "issuerUpdates.detach"; params { id:
// <document id> }; the update's issuer authority (requireProfileOwner). The
// documents of a published update are permanent (0090 refuses the delete).
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireArea } from "@/lib/server/feature-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { requireProfileOwner } from "@/lib/server/profile-read";
import {
  DOCUMENTS_TABLE,
  loadDocument,
  loadUpdate,
  readUuid,
  recordOf,
  unavailable,
} from "@/lib/server/issuer-updates";

export async function POST(request: Request) {
  try {
    requireArea("issuance");
    const { wallet, params } = await verifySigned(request, "issuerUpdates.detach");
    const id = readUuid(params.id, "The document");
    const sb = getSupabaseAdmin(AbortSignal.timeout(8_000));
    const doc = await loadDocument(sb, id);
    const update = doc ? await loadUpdate(sb, doc.update_id) : null;
    if (!doc || !update) throw new SiwsError(404, "Document not found");
    await requireProfileOwner(wallet, update.issuer_pda, "issuer");
    if (update.status !== "draft") throw new SiwsError(409, "The documents of a published update cannot be removed");

    const { error } = await sb.from(DOCUMENTS_TABLE).delete().eq("network", detectNetwork()).eq("id", id);
    if (error?.code === "23514") throw new SiwsError(409, "The update was published meanwhile; its documents are permanent");
    if (error) unavailable();
    return NextResponse.json({ ok: true, data: { update: await recordOf(sb, update.id) } }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
