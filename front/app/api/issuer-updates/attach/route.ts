// POST /api/issuer-updates/attach — attach a verified document to a DRAFT.
// KYC-only mode: composing is issuance activity, refused before the
// signature (requireArea). Signed "issuerUpdates.attach".
//
// params: { id: <draft id>, path, sha256, file_name }. `path` and `sha256`
// are what /api/storage/finalize answered for an upload the issuer's
// authority made under issuer-updates/<issuer>/ (the upload route allows
// nobody else there, and finalize hashed the stored bytes). Here:
//   - requireIssuerAuthor: the signer is the update's issuer authority, KYB
//     Verified on chain;
//   - the path must sit under this issuer's prefix on this network, and
//     requireDocumentVersion (lib/server/document-versions, the check every
//     published whitepaper and sale document passes) must find exactly that
//     verified version, same SHA-256, in the private bucket;
//   - the row repeats the version's path, hash, size and type; 0090 checks
//     all of it again, that the update is still a draft (under its lock) and
//     the 10-document cap.
// file_name is only the name readers see (lib/issuer-updates.ts
// parseDocumentFileName); the stored object keeps its sanitized name.
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireArea } from "@/lib/server/feature-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { requireDocumentVersion } from "@/lib/server/document-versions";
import { ISSUER_UPDATE_PREFIX } from "@/lib/document-integrity";
import { ISSUER_UPDATE_LIMITS, parseDocumentFileName } from "@/lib/issuer-updates";
import {
  DOCUMENTS_TABLE,
  loadDocuments,
  loadUpdate,
  parseOrRefuse,
  readUuid,
  recordOf,
  requireIssuerAuthor,
  unavailable,
} from "@/lib/server/issuer-updates";
import { CONFIDENTIAL_BUCKET } from "@/app/api/storage/_lib";

export async function POST(request: Request) {
  try {
    requireArea("issuance");
    const { wallet, params } = await verifySigned(request, "issuerUpdates.attach");
    const id = readUuid(params.id);
    const fileName = parseOrRefuse(parseDocumentFileName, params.file_name);
    if (typeof params.path !== "string" || params.path.length > 400) throw new SiwsError(400, "The document path is required");
    if (typeof params.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(params.sha256)) {
      throw new SiwsError(400, "The SHA-256 must be 64 lowercase hex characters");
    }

    const sb = getSupabaseAdmin(AbortSignal.timeout(8_000));
    const update = await loadUpdate(sb, id);
    if (!update) throw new SiwsError(404, "Update not found");
    await requireIssuerAuthor(wallet, update.issuer_pda, null);
    if (update.status !== "draft") throw new SiwsError(409, "Documents can be attached to a draft only");
    const network = detectNetwork();
    if (!params.path.startsWith(`${ISSUER_UPDATE_PREFIX}/${update.issuer_pda}/${network}/`)) {
      throw new SiwsError(400, "Upload the document for this issuer first");
    }
    const version = await requireDocumentVersion(CONFIDENTIAL_BUCKET, params.path, params.sha256, sb);
    const existing = (await loadDocuments(sb, [id])).get(id) ?? [];
    if (existing.some((doc) => doc.sha256 === version.sha256 && doc.storage_path === version.path)) {
      throw new SiwsError(409, "This document is already attached");
    }
    if (existing.length >= ISSUER_UPDATE_LIMITS.documents) {
      throw new SiwsError(409, `An update carries at most ${ISSUER_UPDATE_LIMITS.documents} documents`);
    }

    const { error } = await sb.from(DOCUMENTS_TABLE).insert({
      network,
      update_id: id,
      version_id: version.id,
      file_name: fileName,
      storage_path: version.path,
      sha256: version.sha256,
      size_bytes: version.size_bytes,
      content_type: version.mime_type,
      created_by: wallet,
    });
    if (error?.code === "23505") throw new SiwsError(409, "This document is already attached");
    // 23514/23503: published or discarded meanwhile, or a concurrent attach reached the cap (0090 guard).
    if (error?.code === "23514" || error?.code === "23503") {
      throw new SiwsError(409, "The document could not be attached: the update is no longer a draft or already has 10 documents. Reload it.");
    }
    if (error) unavailable();
    return NextResponse.json({ ok: true, data: { update: await recordOf(sb, id) } }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
