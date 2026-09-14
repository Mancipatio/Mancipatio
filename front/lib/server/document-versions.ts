import "server-only";
import { createHash } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { SiwsError } from "@/lib/server/siws";
import {
  assertDocumentBytes,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_STAGING_BUCKET,
} from "@/lib/document-integrity";

export type VerifiedDocumentVersion = {
  id: string;
  network: string;
  bucket: string;
  path: string;
  sha256: string;
  size_bytes: number;
  mime_type: string;
  verified_at: string;
};
export async function requireDocumentVersion(
  bucket: string,
  path: string,
  sha256: unknown,
  sb = getSupabaseAdmin(AbortSignal.timeout(12_000)),
) {
  const { data, error } = await sb
    .from("document_versions")
    .select("*")
    .eq("network", detectNetwork())
    .eq("bucket", bucket)
    .eq("path", path)
    .maybeSingle();
  if (error)
    throw new SiwsError(503, "Document verification lookup unavailable");
  if (!data || data.sha256 !== sha256)
    throw new SiwsError(
      409,
      "Upload and verify an immutable document version before publishing",
    );
  return data as VerifiedDocumentVersion;
}

export async function finalizeDocumentUpload(id: string, wallet: string) {
  const sb = getSupabaseAdmin(AbortSignal.timeout(45_000));
  const { data: upload, error } = await sb
    .from("document_uploads")
    .select("*")
    .eq("id", id)
    .eq("wallet", wallet)
    .eq("network", detectNetwork())
    .maybeSingle();
  if (error) throw new SiwsError(503, "Upload lookup unavailable");
  if (!upload) throw new SiwsError(404, "Upload authorization not found");
  if (upload.verified_version_id)
    return requireDocumentVersion(
      upload.bucket,
      upload.path,
      upload.sha256,
      sb,
    );
  const source = await sb.storage
    .from(DOCUMENT_STAGING_BUCKET)
    .download(upload.staging_path);
  if (source.error || !source.data)
    throw new SiwsError(
      503,
      "Uploaded file is not yet available; retry verification",
    );
  if (
    source.data.size > DOCUMENT_MAX_BYTES ||
    source.data.size !== upload.size_bytes
  )
    throw new SiwsError(
      400,
      "Uploaded size does not match the signed declaration",
    );
  const bytes = new Uint8Array(await source.data.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  try {
    assertDocumentBytes(bytes, upload.size_bytes, sha256, upload.sha256);
  } catch (error) {
    throw new SiwsError(400, (error as Error).message);
  }
  // No signed upload token ever targets this destination. An existing object
  // may be the result of a previous successful copy followed by DB failure.
  const saved = await sb.storage
    .from(upload.bucket)
    .upload(upload.path, bytes, {
      contentType: upload.mime_type,
      upsert: false,
      cacheControl: "31536000",
    });
  if (saved.error) {
    const existing = await sb.storage.from(upload.bucket).download(upload.path);
    if (existing.error || !existing.data)
      throw new SiwsError(
        503,
        "Verified document storage unavailable; retry verification",
      );
    if (
      existing.data.size !== bytes.byteLength ||
      createHash("sha256")
        .update(new Uint8Array(await existing.data.arrayBuffer()))
        .digest("hex") !== sha256
    )
      throw new SiwsError(
        409,
        "This document path already contains different bytes; choose a new version",
      );
  }
  const recorded = await sb.from("document_versions").upsert(
    {
      network: detectNetwork(),
      bucket: upload.bucket,
      path: upload.path,
      sha256,
      size_bytes: bytes.byteLength,
      mime_type: upload.mime_type,
      verified_by: wallet,
    },
    { onConflict: "network,bucket,path", ignoreDuplicates: true },
  );
  if (recorded.error)
    throw new SiwsError(
      503,
      "File verified; version recording unavailable. Retry verification",
    );
  const version = await requireDocumentVersion(
    upload.bucket,
    upload.path,
    sha256,
    sb,
  );
  const linked = await sb
    .from("document_uploads")
    .update({ verified_version_id: version.id })
    .eq("id", id)
    .eq("wallet", wallet)
    .eq("network", detectNetwork());
  if (linked.error)
    throw new SiwsError(
      503,
      "Version created; upload receipt recording unavailable. Retry verification",
    );
  // Only the private staging copy is removed; immutable published bytes stay.
  await sb.storage.from(DOCUMENT_STAGING_BUCKET).remove([upload.staging_path]);
  return version;
}
