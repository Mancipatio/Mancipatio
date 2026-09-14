// POST /api/clients/doc-url — resolve a KYC document to a time-limited URL
// (SIWS + requireAdmin). Action: "clients.doc-url".
// Client half: lib/clients.ts getClientDocumentUrl().
//
// New uploads live in the PRIVATE "client-documents" bucket → 60-minute
// signed URL. Legacy (pre-P1) rows still point into the public "documents"
// bucket → public URL fallback when no private object exists.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { assertPositiveInt, documentUrlFor, fetchClientOr404 } from "../_helpers";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "clients.doc-url");
    await requireAdmin(wallet);

    const documentId = assertPositiveInt(params.document_id, "document_id");

    const sb = getSupabaseAdmin();
    const { data: doc, error } = await sb
      .from("client_documents")
      .select("id, client_id, storage_path")
      .eq("id", documentId)
      .maybeSingle();
    if (error) throw new SiwsError(500, "Database read failed");
    if (!doc) throw new SiwsError(404, "Document not found");
    await fetchClientOr404(sb, String(doc.client_id));

    const url = await documentUrlFor(
      sb,
      (doc as { storage_path: string }).storage_path,
    );
    if (!url) throw new SiwsError(500, "Could not resolve a document URL");

    return NextResponse.json({ ok: true, data: { url } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
