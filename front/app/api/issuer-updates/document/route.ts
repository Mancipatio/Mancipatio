// GET /api/issuer-updates/document?id=<document id> — open: a document of a
// PUBLISHED, PUBLIC update. Answers a 302 to a signed URL of the private
// bucket (documents-confidential), valid DOCUMENT_URL_TTL_S, so the link on
// the asset page can open in a new tab. Every other file (a holders-only,
// draft or withdrawn update's, an unknown id, an archived issuer's or
// asset's) answers 404 without saying which: holders, the issuer and the
// admins use the signed /api/issuer-updates/document-url instead. A
// withdrawal therefore stops this link at once. Open in KYC-only mode.
import { NextResponse } from "next/server";
import { SiwsError, siwsErrorResponse } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import {
  hiddenByArchive,
  loadDocument,
  loadUpdate,
  readUuid,
  signDocumentUrl,
} from "@/lib/server/issuer-updates";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const id = readUuid(new URL(request.url).searchParams.get("id"), "The document");
    const sb = getSupabaseAdmin(AbortSignal.timeout(8_000));
    const doc = await loadDocument(sb, id);
    const update = doc ? await loadUpdate(sb, doc.update_id) : null;
    if (!doc || !update || update.status !== "published" || update.visibility !== "public" ||
        (await hiddenByArchive(sb, update.issuer_pda, update.asset_pda))) {
      throw new SiwsError(404, "Document not found");
    }
    const url = await signDocumentUrl(sb, doc.storage_path);
    return NextResponse.redirect(url, { status: 302, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
