// POST /api/issuer-updates/document-url — a signed URL (DOCUMENT_URL_TTL_S)
// for ONE attachment, made on click. Signed "issuerUpdates.documentUrl" (a
// session read, lib/siws-session.ts; nothing is written).
//
// params: { id: <document id>, asset?: <Asset PDA> }. Who may open it:
//   - a document of a published PUBLIC update: any signing wallet (the open
//     GET /api/issuer-updates/document serves the same file to anyone);
//   - a document of a published HOLDERS update: a wallet verifyHeldAssets
//     finds holding the update's asset, or, for an issuer-wide update, the
//     `asset` it names (via_asset of the holder read), which must be one of
//     the update's issuer's assets on chain;
//   - anything else (a draft, a withdrawn update, a reader who holds
//     nothing): the issuer's own authority (its drafts and records) or a
//     platform admin (moderation).
// 404 for an unknown id, 403 for anyone else; an RPC failure is a 503 (fail
// closed: no URL). Open in KYC-only mode (a read).
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { isProfileAdmin } from "@/lib/server/profile-read";
import {
  DOCUMENT_URL_TTL_S,
  isIssuerAuthority,
  loadDocument,
  loadUpdate,
  readAddress,
  readUuid,
  signDocumentUrl,
  verifyHeldAssets,
  type IssuerUpdateRow,
} from "@/lib/server/issuer-updates";

export const maxDuration = 30;

/** Whether the published holders-only `update` may be read by `wallet` through `asset` (checked on chain). */
async function holderMayRead(wallet: string, update: IssuerUpdateRow, asset: string | null): Promise<boolean> {
  const through = update.asset_pda ?? asset;
  if (!through) return false;
  const held = await verifyHeldAssets(wallet, [through]);
  return held.some((h) => h.asset === through && h.issuer === update.issuer_pda);
}

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "issuerUpdates.documentUrl");
    const id = readUuid(params.id, "The document");
    const asset = params.asset === undefined || params.asset === null ? null : readAddress(params.asset, "The asset");

    const sb = getSupabaseAdmin(AbortSignal.timeout(8_000));
    const doc = await loadDocument(sb, id);
    const update = doc ? await loadUpdate(sb, doc.update_id) : null;
    if (!doc || !update) throw new SiwsError(404, "Document not found");

    const published = update.status === "published";
    const allowed =
      (published && update.visibility === "public") ||
      (published && update.visibility === "holders" && (await holderMayRead(wallet, update, asset))) ||
      (await isIssuerAuthority(wallet, update.issuer_pda)) ||
      (await isProfileAdmin(wallet));
    if (!allowed) {
      throw new SiwsError(403, published
        ? "Only holders of this asset can open this document"
        : "This document is not published");
    }

    const url = await signDocumentUrl(sb, doc.storage_path);
    return NextResponse.json(
      { ok: true, data: { url, expires_in: DOCUMENT_URL_TTL_S } },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
