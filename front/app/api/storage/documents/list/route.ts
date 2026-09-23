// POST /api/storage/documents/list — admin read of the global document
// repository (public.documents) WITH download links where they are public.
//
// Signed + requireAdmin. The metadata table exposes storage_path values for
// every category — including unpublished drafts and confidential
// compliance / issuer-agreement rows — so its anon SELECT policy is dropped
// in 0031 and /admin/documents reads through this route.
//
// Each row gains a `download_url`:
//   - external rows            -> the stored external_url
//   - public categories        -> raw public-bucket URL (whitepapers, legal,
//     marketing, KYB templates — public by design)
//   - confidential categories  -> NULL plus `download_on_request: true`.
//     Compliance memos can name clients, so their links are never pre-signed
//     here (a list load would otherwise mint a link for every confidential
//     file, unlogged): the page asks /api/storage/documents/url for ONE
//     short-lived, audit-logged link when the admin clicks. There is no
//     public-URL fallback either — a legacy object that never moved out of the
//     public bucket (ops note in 0031) gets a 404 from that route.
//
// Client KYC files (client_documents, bucket client-documents) never pass
// through here — they are resolved one at a time, logged, by
// /api/clients/doc-url.
//
// Client: app/admin/documents/page.tsx (action "storage.documents.list").

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { CONFIDENTIAL_CATEGORIES, publicUrlFor } from "../../_lib";

type DocumentRow = {
  id: string;
  category: string;
  storage_path: string | null;
  external_url: string | null;
  [key: string]: unknown;
};

export async function POST(request: Request) {
  try {
    const { wallet } = await verifySigned(request, "storage.documents.list");
    await requireAdmin(wallet);

    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("documents")
      .select("*")
      .order("category", { ascending: true })
      .order("slug", { ascending: true })
      .order("version", { ascending: false });
    if (error) {
      console.error("[api/storage/documents/list] query failed:", error.message);
      throw new SiwsError(500, "Could not load documents");
    }
    const rows = (data ?? []) as DocumentRow[];

    const documents = rows.map((r) => {
      if (r.storage_path && CONFIDENTIAL_CATEGORIES.has(r.category)) {
        // Signed on click, logged — never here, never a public URL.
        return { ...r, download_url: null, download_on_request: true };
      }
      const downloadUrl = r.storage_path
        ? publicUrlFor(r.storage_path)
        : r.external_url ?? null;
      return { ...r, download_url: downloadUrl };
    });

    return NextResponse.json({ ok: true, data: { documents } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
