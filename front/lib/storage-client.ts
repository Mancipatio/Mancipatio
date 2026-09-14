// Signed upload: authorize a private staging path, upload directly to Storage,
// then finalize through the server. Finalization reads the uploaded bytes,
// verifies SHA-256 and size, and creates an immutable published version.
// File bytes are never sent in a serverless request body.

import type { WalletSession } from "@solana/client";
import { signedFetch } from "@/lib/siws-client";
import { getSupabase } from "@/lib/supabase";

/** Max upload size — keep in sync with app/api/storage/upload/route.ts. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** MIME allowlist — keep in sync with the route. */
export const UPLOAD_MIME_ALLOWLIST = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

const EXT_TO_MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** Resolve the MIME type to declare for a file (extension fallback — some
 *  browsers report an empty `File.type` for docx). */
export function uploadContentType(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_MIME[ext] ?? "application/octet-stream";
}

/** SHA-256 of a File, as lowercase hex. */
export async function sha256HexOfFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(hash);
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

export type SignedUploadResult = {
  versionId: string;
  bucket: string;
  path: string;
  sha256: string;
  size: number;
};

type AuthorizeResponse = {
  uploadId: string;
  bucket: string;
  path: string;
  token: string;
  sha256: string;
  size: number;
};

/**
 * Upload a file via the signed-authorization + direct-to-storage flow.
 *
 * @param session   Connected wallet session (useWalletConnection().wallet).
 * @param opts.path Bucket-relative object path, e.g. "whitepapers/<pda>/x.pdf".
 * @param opts.file The file to upload (≤ 25MB).
 * @param opts.sha256 Optional precomputed sha256 hex (skips rehashing).
 * @returns         { bucket, path, sha256, size } of the stored object.
 * @throws          Error with the server's message on any failure.
 */
export async function signedUpload(
  session: WalletSession | null | undefined,
  opts: { path: string; file: File; sha256?: string },
): Promise<SignedUploadResult> {
  if (!session) throw new Error("Wallet not connected");
  const { path, file } = opts;
  if (file.size === 0) throw new Error("File is empty");
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("File exceeds the 25MB upload limit");
  }

  const contentType = uploadContentType(file);
  // Fail BEFORE the wallet-signature prompt — the route rejects anything
  // outside the allowlist anyway, but only after the user has signed.
  if (!(UPLOAD_MIME_ALLOWLIST as readonly string[]).includes(contentType)) {
    throw new Error("Unsupported file type — allowed: PDF, PNG, JPG, DOCX");
  }

  const sha256 = opts.sha256 ?? (await sha256HexOfFile(file));

  // Step 1 — signed authorization; server returns a one-time upload token.
  const auth = (await signedFetch(
    session,
    "/api/storage/upload",
    "storage.upload",
    {
      bucket: "documents",
      path,
      contentType,
      sha256,
      size: file.size,
    },
  )) as AuthorizeResponse;
  if (!auth?.token || !auth.bucket || !auth.uploadId) {
    throw new Error("Upload authorization failed — no token returned");
  }

  // Step 2 — direct upload to storage with the one-time token. The anon
  // client is fine here: the token, not bucket policy, authorizes the write.
  const supabase = getSupabase();
  if (!supabase) {
    throw new Error("Storage is not configured (Supabase unavailable)");
  }
  const { error } = await supabase.storage
    .from(auth.bucket)
    .uploadToSignedUrl(auth.path, auth.token, file, { contentType });
  if (error) {
    throw new Error(`Storage upload failed: ${error.message}`);
  }

  // Step 3 — verify actual stored bytes and receive their immutable version.
  return (await signedFetch(
    session,
    "/api/storage/finalize",
    "storage.finalize",
    { uploadId: auth.uploadId },
  )) as SignedUploadResult;
}
