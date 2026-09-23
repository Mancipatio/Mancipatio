// POST /api/storage/documents/url — resolve ONE confidential repository
// document (compliance / issuer-agreement / other, private bucket
// documents-confidential) to a short-lived signed URL for an admin, and log
// the access. Action: "storage.documents.url", params { id }.
// Client: app/admin/documents/page.tsx (ConfidentialDocLink).
//
// Confidential files can name clients, so they get the same treatment as KYC
// documents (/api/clients/doc-url): signed on click, never pre-signed in the
// list, valid CONFIDENTIAL_URL_TTL_S (120 s), and an audit row (category
// "kyc" — the server-only "KYC & privacy" category, ix_name
// "confidential_document_view", target "document:<id>") is written BEFORE
// the URL is returned; if it cannot be written the route answers 503 and
// hands out nothing. Session read (lib/siws-session.ts): the access-log row is
// the only write.
//
// Answers: 404 when the row or its file in the private bucket does not exist
// (a pre-0031 object still in the public bucket must be moved — 0031 ops
// note), 503 when storage could not sign, 400 for a public-category document
// (its list entry already carries the public URL).

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { actorSourceOf, writeServerAudit } from "@/lib/server/audit";
import { CONFIDENTIAL_BUCKET, CONFIDENTIAL_CATEGORIES, CONFIDENTIAL_URL_TTL_S } from "../../_lib";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(request, "storage.documents.url");
    await requireAdmin(wallet);

    const id = params.id;
    if (typeof id !== "string" || !UUID_RE.test(id)) throw new SiwsError(400, "id must be a UUID");

    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("documents")
      .select("id, category, storage_path")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new SiwsError(500, "Could not load the document");
    if (!data) throw new SiwsError(404, "Document not found");
    const doc = data as { category: string; storage_path: string | null };
    if (!CONFIDENTIAL_CATEGORIES.has(doc.category)) {
      throw new SiwsError(400, "Only confidential documents are resolved here");
    }
    if (!doc.storage_path) throw new SiwsError(404, "This document has no stored file");

    const { data: signed, error: signError } = await sb.storage
      .from(CONFIDENTIAL_BUCKET)
      .createSignedUrl(doc.storage_path, CONFIDENTIAL_URL_TTL_S);
    if (signError || !signed?.signedUrl) {
      const message = signError?.message ?? "";
      if (/not.?found/i.test(message)) {
        throw new SiwsError(404, "The file is not in the private bucket — move it there first (it may still be in the old public bucket)");
      }
      console.error("[api/storage/documents/url] signing failed:", message || "no URL");
      throw new SiwsError(503, "Could not sign the download link — try again");
    }

    // Logged before the URL leaves the server; a failed write throws 503.
    await writeServerAudit(sb, {
      ix_name: "confidential_document_view",
      category: "kyc",
      actor_wallet: wallet,
      actor_source: actorSourceOf(via),
      reason: "Opened a confidential repository document",
      target_label: `document:${id}`,
      metadata: {
        document_id: id,
        document_category: doc.category,
        ttl: CONFIDENTIAL_URL_TTL_S,
        actor_wallet: wallet,
      },
    });

    return NextResponse.json(
      { ok: true, data: { url: signed.signedUrl, expires_in: CONFIDENTIAL_URL_TTL_S } },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
