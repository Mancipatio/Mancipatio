// POST /api/storage/documents/list — admin read of the global document
// repository (public.documents) WITH resolved download URLs.
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
//   - confidential categories  -> 60-minute service-role signed URL on the
//     PRIVATE documents-confidential bucket, or NULL when it cannot be signed.
//     There is deliberately NO public-URL fallback: compliance memos can name
//     clients, and a permanent public link to a confidential file (a legacy
//     object that never moved out of the public bucket — ops note in 0031)
//     must not be handed out and copied around. Such rows carry
//     `download_unavailable: "not_in_private_bucket"` so the ops move is
//     visible instead of silently papered over.
//
// This route lists the global document repository only (public.documents).
// Client KYC files (client_documents, bucket client-documents) never pass
// through here — they are resolved one at a time, logged, by
// /api/clients/doc-url.
//
// Client: app/admin/documents/page.tsx (action "storage.documents.list").

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import {
  CONFIDENTIAL_BUCKET,
  CONFIDENTIAL_CATEGORIES,
  CONFIDENTIAL_URL_TTL_S,
  publicUrlFor,
} from "../../_lib";

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

    // Batch-sign confidential paths (one storage call for the whole page).
    const confidentialPaths = rows
      .filter(
        (r) =>
          r.storage_path !== null && CONFIDENTIAL_CATEGORIES.has(r.category),
      )
      .map((r) => r.storage_path as string);
    const signedByPath = new Map<string, string>();
    if (confidentialPaths.length > 0) {
      const { data: signed, error: signError } = await sb.storage
        .from(CONFIDENTIAL_BUCKET)
        .createSignedUrls(confidentialPaths, CONFIDENTIAL_URL_TTL_S);
      if (signError) {
        // Bucket missing (0031 not applied yet) or storage hiccup — the
        // confidential rows list without a link rather than failing the page.
        console.warn(
          "[api/storage/documents/list] signed-url batch failed:",
          signError.message,
        );
      } else {
        for (const item of signed ?? []) {
          if (!item.error && item.path && item.signedUrl) {
            signedByPath.set(item.path, item.signedUrl);
          }
        }
      }
    }

    const documents = rows.map((r) => {
      let downloadUrl: string | null = null;
      let unavailable: string | null = null;
      if (r.storage_path) {
        if (CONFIDENTIAL_CATEGORIES.has(r.category)) {
          // Signed private URL or nothing — never a public-bucket URL.
          downloadUrl = signedByPath.get(r.storage_path) ?? null;
          if (!downloadUrl) unavailable = "not_in_private_bucket";
        } else {
          downloadUrl = publicUrlFor(r.storage_path);
        }
      } else if (r.external_url) {
        downloadUrl = r.external_url;
      }
      return {
        ...r,
        download_url: downloadUrl,
        ...(unavailable ? { download_unavailable: unavailable } : {}),
      };
    });

    return NextResponse.json({ ok: true, data: { documents } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
