// The browser half of the public certificate check (/certificates/verify):
// the unsigned call to POST /api/certificates/verify, and the reading of a
// certificate's JSON file in the browser (it is never uploaded; only its
// hash is sent). Kept apart from lib/certificates-client.ts (the admin's
// signed calls) so the public page loads no wallet signing code.

import { canonicalJson, sha256HexOfBytes, sha256HexOfText } from "@/lib/certificates/canonical";
import type { PublicCertificateView } from "@/lib/certificates/payload";
import { CERTIFICATE_PATHS } from "@/lib/certificates/routes";

/** The public check. Throws the server's refusal (400, 413, 429, 503) as a sentence. */
export async function verifyCertificate(number: string, sha256?: string): Promise<PublicCertificateView> {
  const res = await fetch(CERTIFICATE_PATHS.verify, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ number, ...(sha256 ? { sha256 } : {}) }),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: PublicCertificateView; error?: string } | null;
  if (!res.ok || !json?.ok || !json.data) throw new Error(json?.error ?? `The check failed (${res.status}). Try again.`);
  return json.data;
}

/** The largest JSON file the verification page reads. */
export const CERTIFICATE_JSON_MAX_BYTES = 64 * 1024;

/**
 * An uploaded certificate JSON, read in the browser: the SHA-256 of its exact
 * bytes, the SHA-256 of its canonical form when it is in the certificate
 * format (a reformatted copy of the same content), its number and its parsed
 * content. Throws with a sentence for the page when the file is too large or
 * not JSON.
 */
export async function readCertificateFile(file: File): Promise<{
  rawSha256: string;
  canonicalSha256: string | null;
  number: string | null;
  payload: Record<string, unknown> | null;
}> {
  if (file.size > CERTIFICATE_JSON_MAX_BYTES) throw new Error("This file is larger than a certificate's JSON (64 KB at most).");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const rawSha256 = await sha256HexOfBytes(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("This file is not a certificate's JSON (it does not parse as UTF-8 JSON).");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("This file is not a certificate's JSON.");
  const payload = parsed as Record<string, unknown>;
  let canonicalSha256: string | null = null;
  try {
    canonicalSha256 = await sha256HexOfText(canonicalJson(payload));
  } catch {
    canonicalSha256 = null;
  }
  return { rawSha256, canonicalSha256, number: typeof payload.number === "string" ? payload.number : null, payload };
}
