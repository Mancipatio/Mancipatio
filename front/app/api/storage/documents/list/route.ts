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
//   - public categories        -> raw public-bucket URL (unchanged behavior)
//   - confidential categories  -> 60-minute service-role signed URL on the
//     PRIVATE documents-confidential bucket; legacy objects uploaded before
//     the bucket split still live in the public bucket, so a failed signing
//     falls back to the public URL (works while the object remains there —
//     see the ops note in 0031 about moving them).
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
        // Bucket missing (0031 not applied yet) or storage hiccup — fall back
        // to legacy public URLs below rather than failing the whole list.
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
      if (r.storage_path) {
        downloadUrl = CONFIDENTIAL_CATEGORIES.has(r.category)
          ? (signedByPath.get(r.storage_path) ??
            // Legacy fallback: object still in the public bucket.
            publicUrlFor(r.storage_path))
          : publicUrlFor(r.storage_path);
      } else if (r.external_url) {
        downloadUrl = r.external_url;
      }
      return { ...r, download_url: downloadUrl };
    });

    return NextResponse.json({ ok: true, data: { documents } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
