// POST /api/storage/documents/create — insert a new version row into the
// global document repository (public.documents). Signed + requireAdmin.
//
// Pairs with /api/storage/upload: the client first uploads the file bytes
// (signed, hash-bound), then records the metadata row here. `uploaded_by`
// is ALWAYS the verified wallet — never client-supplied.
//
// When a storage_path is present it must be exactly
// "<category>/<slug>/v<version>-…" so a row can never point at an object
// outside its own document family.
//
// Client: app/admin/documents/page.tsx (action "storage.documents.create").

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { requireDocumentVersion } from "@/lib/server/document-versions";
import { bucketForPrefix } from "../../_lib";

const CATEGORIES = new Set([
  "legal",
  "kyb-template",
  "issuer-agreement",
  "compliance",
  "marketing",
  "other",
]);
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function optionalString(
  v: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || v.length > maxLength) {
    throw new SiwsError(400, `Invalid ${field}`);
  }
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(
      request,
      "storage.documents.create",
    );
    await requireAdmin(wallet);

    const category =
      typeof params.category === "string" ? params.category : "";
    if (!CATEGORIES.has(category)) {
      throw new SiwsError(400, "Unknown document category");
    }
    const slug = typeof params.slug === "string" ? params.slug.trim() : "";
    if (!SLUG_RE.test(slug)) {
      throw new SiwsError(400, "slug must be 1–80 safe characters");
    }
    const version = params.version;
    if (
      typeof version !== "number" ||
      !Number.isInteger(version) ||
      version < 1 ||
      version > 100_000
    ) {
      throw new SiwsError(400, "version must be a positive integer");
    }
    const title = typeof params.title === "string" ? params.title.trim() : "";
    if (title.length === 0 || title.length > 300) {
      throw new SiwsError(400, "title must be 1–300 characters");
    }
    const description =
      typeof params.description === "string" ? params.description : "";
    if (description.length > 5_000) {
      throw new SiwsError(400, "description too long (max 5000)");
    }

    const storagePath = optionalString(params.storage_path, "storage_path", 350);
    if (storagePath !== null) {
      // The row must reference an object inside its own family's folder —
      // the exact path shape /api/storage/upload just created.
      const requiredPrefix = `${category}/${slug}/v${version}-`;
      if (!storagePath.startsWith(requiredPrefix)) {
        throw new SiwsError(
          400,
          "storage_path must match <category>/<slug>/v<version>-…",
        );
      }
    }
    const externalUrl = optionalString(params.external_url, "external_url", 2_048);
    if (externalUrl !== null && !/^https?:\/\//.test(externalUrl)) {
      throw new SiwsError(400, "external_url must be http(s)");
    }
    const sha256 = optionalString(params.sha256, "sha256", 64);
    if (sha256 !== null && !SHA256_RE.test(sha256)) {
      throw new SiwsError(400, "sha256 must be 64 lowercase hex chars");
    }
    const sizeBytes = params.size_bytes;
    if (
      sizeBytes !== undefined &&
      sizeBytes !== null &&
      (typeof sizeBytes !== "number" ||
        !Number.isInteger(sizeBytes) ||
        sizeBytes < 0)
    ) {
      throw new SiwsError(400, "size_bytes must be a non-negative integer");
    }
    const mimeType = optionalString(params.mime_type, "mime_type", 200);

    const sb = getSupabaseAdmin();
    const verified = storagePath ? await requireDocumentVersion(bucketForPrefix(category),storagePath,sha256) : null;
    const { data, error } = await sb
      .from("documents")
      .insert({
        category,
        slug,
        version,
        title,
        description,
        storage_path: storagePath,
        // Storage path takes precedence — same rule as the old client code.
        external_url: storagePath ? null : externalUrl,
        sha256: verified?.sha256 ?? sha256,
        size_bytes: verified?.size_bytes ?? (sizeBytes as number | null | undefined) ?? null,
        mime_type: verified?.mime_type ?? mimeType,
        verified_version_id: verified?.id ?? null,
        uploaded_by: wallet,
      })
      .select("id, version")
      .single();
    if (error) {
      // unique (category, slug, version) — concurrent upload of same version.
      if (error.code === "23505") {
        throw new SiwsError(
          409,
          "This version already exists — refresh and retry",
        );
      }
      console.error("[api/storage/documents/create] insert failed:", error.message);
      throw new SiwsError(500, "Document record write failed");
    }

    return NextResponse.json({
      ok: true,
      data: { id: data.id as string, version: data.version as number },
    });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
