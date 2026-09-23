// POST /api/clients/doc-url — resolve ONE KYC document to a signed URL for an
// admin, and log the access (SIWS or wallet session + requireAdmin).
// Action: "clients.doc-url". Client half: lib/clients.ts getClientDocumentUrl().
//
// Documents live in the PRIVATE "client-documents" bucket; the URL is signed
// for KYC_DOC_URL_TTL_S (120 s). There is NO public-bucket fallback: a legacy
// pre-P1 row whose object never moved into the private bucket gets a 404, not
// a public link (see documentUrlFor in ../_helpers).
//
// Access logging: every view appends a server-attributed audit_events row
// (ix_name "kyc_document_view", category "kyc", target = client id,
// metadata {document_id, kind, ttl, actor_wallet}) BEFORE the URL is
// returned. If that row cannot be written the route answers 503 and hands out
// no URL — an unlogged view never happens. The client timeline also gets a
// best-effort system note, except during maintenance.
//
// "clients.doc-url" is a session read (lib/siws-session.ts): viewing needs no
// fresh signature and keeps working during maintenance. The access-log row is
// the one write a session read may make (it records the read itself); the
// timeline note touches client_notes / clients.notes_count, so it is skipped
// while maintenance is on — the audit row still records the view.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { actorSourceOf, writeServerAudit } from "@/lib/server/audit";
import { getMaintenance } from "@/lib/server/maintenance";
import { detectNetwork } from "@/lib/network";
import {
  assertPositiveInt,
  documentUrlFor,
  fetchClientOr404,
  insertNote,
  KYC_DOC_URL_TTL_S,
} from "../_helpers";

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(request, "clients.doc-url");
    await requireAdmin(wallet);

    const documentId = assertPositiveInt(params.document_id, "document_id");

    const sb = getSupabaseAdmin();
    const { data: doc, error } = await sb
      .from("client_documents")
      .select("id, client_id, kind, storage_path")
      .eq("id", documentId)
      .maybeSingle();
    if (error) throw new SiwsError(500, "Database read failed");
    if (!doc) throw new SiwsError(404, "Document not found");
    const row = doc as { client_id: string; kind: string | null; storage_path: string };
    // Network-bound: a document of another network's dossier is a 404 here.
    const client = await fetchClientOr404(sb, String(row.client_id));

    const url = await documentUrlFor(sb, row.storage_path, KYC_DOC_URL_TTL_S);
    if (!url) throw new SiwsError(404, "Document file is not available");

    // Logged before the URL leaves the server; a failed write throws 503.
    await writeServerAudit(sb, {
      ix_name: "kyc_document_view",
      category: "kyc",
      actor_wallet: wallet,
      actor_source: actorSourceOf(via),
      reason: "Viewed a KYC document",
      target_label: client.id,
      metadata: {
        client_id: client.id,
        document_id: documentId,
        kind: row.kind ?? null,
        ttl: KYC_DOC_URL_TTL_S,
        actor_wallet: wallet,
      },
    });
    // Business data stays frozen during maintenance (getMaintenance never
    // throws; an unreadable flag keeps the last known state).
    if (!(await getMaintenance(detectNetwork())).enabled) {
      await insertNote(
        sb,
        client.id,
        wallet,
        `Viewed document #${documentId} (${row.kind ?? "document"}) — link valid ${KYC_DOC_URL_TTL_S} s.`,
        "system",
      );
    }

    return NextResponse.json(
      { ok: true, data: { url, expires_in: KYC_DOC_URL_TTL_S } },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
