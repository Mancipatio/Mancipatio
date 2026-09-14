// SERVER-ONLY — shared constants/helpers for the /api/storage/* routes.
// The `_lib` underscore prefix keeps this file out of routing.
//
// TWO physical buckets back the logical "documents" store:
//   - PUBLIC_BUCKET ("documents", public=true): whitepapers + the
//     public-by-design document categories (ToS/legal, marketing, KYB
//     templates). Objects here are served by raw public URLs.
//   - CONFIDENTIAL_BUCKET ("documents-confidential", public=false, created in
//     0031): compliance memos, issuer agreements and "other". Objects here
//     are reachable ONLY via service-role signed URLs minted by the signed
//     admin routes — never by a public URL.
//
// The client-facing protocol keeps a single logical bucket name ("documents",
// signature-covered in the upload params); the server picks the physical
// bucket from the path's category prefix so confidential bytes can never land
// somewhere world-readable.

import "server-only";

export const PUBLIC_BUCKET = "documents";
export const CONFIDENTIAL_BUCKET = "documents-confidential";

/** Signed-URL lifetime for confidential documents (seconds). */
export const CONFIDENTIAL_URL_TTL_S = 3_600;

/**
 * documents-table categories whose files are confidential. Keep in sync with
 * the storage policy rationale in 0031: only published legal / marketing /
 * kyb-template files (and whitepapers) are meant to be world-readable.
 */
export const CONFIDENTIAL_CATEGORIES = new Set([
  "compliance",
  "issuer-agreement",
  "other",
]);

/** Physical bucket for a storage path's top-level prefix (category). */
export function bucketForPrefix(prefix: string): string {
  return CONFIDENTIAL_CATEGORIES.has(prefix)
    ? CONFIDENTIAL_BUCKET
    : PUBLIC_BUCKET;
}

/** Raw public URL for an object in the public bucket. */
export function publicUrlFor(path: string): string | null {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return base
    ? `${base}/storage/v1/object/public/${PUBLIC_BUCKET}/${path}`
    : null;
}
