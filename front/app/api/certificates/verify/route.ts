// POST /api/certificates/verify — PUBLIC check of a certificate of tokenized
// interest by its number, for /certificates/verify (and anyone's own client:
// an authority's script may call it). Unsigned, read-only, open in KYC-only
// mode: it records nothing and offers nothing, it answers what the operator
// issued.
//
// Body: { number: "MC-2026-0001" (case and leading zeros forgiven),
//         sha256?: the hash printed on the certificate (the printed link
//         carries it), or the one the page computed from an uploaded JSON }
// Answer (lib/certificates/payload.ts publicCertificateView):
//   * { found: false } for an unknown number, a draft, or a draft discarded
//     before it was signed (none of them was ever issued);
//   * a number alone, or with a hash that is not the certificate's: only
//     { found, details: false, status ("valid", "revoked" with its date, or
//     "invalid" when the route's own re-check fails), hash_matches (null or
//     false), hint }. Numbers are sequential, so contents by number alone
//     would let anyone walk MC-YYYY-0001… and list which wallets obtained
//     certificates; a real verifier holds the printed certificate, number
//     and SHA-256 both. No wallet, units, percentages, company, asset or
//     class, signer, signature or anchor here;
//   * the number with the certificate's own SHA-256: { details: true } and
//     everything it states: the kind, the issue date, the company, asset,
//     share class, units and percentages, the holder's wallet, the signer,
//     the signature and the bytes it covers, and the anchor transaction.
// Never the holder's name or ID number, the statement that repeats them,
// the revocation reason, or who created or revoked the row: the route
// selects only PUBLIC_CERTIFICATE_COLUMNS, and the projection copies named
// fields of the payload one by one. An anchored certificate's hash is in its
// memo on chain, so the hash gate stops walking this route by number; someone
// who reads the Super Admin's anchor memos can still open anchored
// certificates one by one (the units and wallets are on chain anyway).
//
// Before it answers "valid" it re-hashes the stored canonical payload and
// re-verifies the stored signature against the signer and the message
// rebuilt from the number and hash (lib/certificates/signature.ts); a runtime
// that cannot verify answers 503, never "valid".
//
// Abuse: the body is capped at 2 KiB; a per-instance burst limit per client
// address, then a limit shared by every instance (lib/server/shared-rate-
// limit.ts; when the database cannot count, the per-instance limit still
// applies, and the read that follows fails anyway). Numbers are sequential,
// so the limits bound enumeration; the facts shown are on chain already.
import { NextResponse } from "next/server";
import { SiwsError, siwsErrorResponse } from "@/lib/server/siws";
import { boundedRequest } from "@/lib/server/bounded-request";
import { consumeSharedRateLimit } from "@/lib/server/shared-rate-limit";
import { PUBLIC_CERTIFICATE_COLUMNS, certificatesUnavailable } from "@/lib/server/certificates";
import { clientIpOf, ipRateLimitKey, rateLimited } from "@/app/api/clients/_helpers";
import { sha256HexOfText } from "@/lib/certificates/canonical";
import {
  certificateMessage,
  normalizeCertificateNumber,
  publicCertificateView,
  type CertificateRow,
} from "@/lib/certificates/payload";
import { certificateSignatureFormat } from "@/lib/certificates/signature";
import { normalizeSha256Input } from "@/lib/document-anchor";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

const BODY_LIMIT_BYTES = 2_048;
/** Per instance, per client address: a burst. */
const BURST_LIMIT = 20;
const BURST_WINDOW_MS = 60_000;
/** Shared by every instance, per client address: well above an office checking a stack of certificates. */
const SHARED_LIMIT = 60;
const SHARED_WINDOW_SECONDS = 600;
const headers = { "Cache-Control": "no-store" };

type PublicRow = Pick<
  CertificateRow,
  "number" | "network" | "kind" | "status" | "payload_canonical" | "payload_sha256" | "signer" | "signature" |
  "signature_format" | "signed_at" | "anchor_tx" | "anchor_slot" | "anchor_block_time" | "revoked_at"
>;

export async function POST(request: Request) {
  try {
    const ipKey = ipRateLimitKey(clientIpOf(request));
    if (rateLimited(`certificate-verify:${ipKey}`, BURST_LIMIT, BURST_WINDOW_MS)) {
      throw new SiwsError(429, "Too many checks from this address — wait a minute and try again");
    }
    let body: unknown;
    try {
      body = await (await boundedRequest(request, BODY_LIMIT_BYTES)).json();
    } catch (err) {
      if (err instanceof SiwsError && err.status === 413) throw err;
      throw new SiwsError(400, "Send the certificate number as JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new SiwsError(400, "Send the certificate number as JSON");
    const fields = body as Record<string, unknown>;
    const number = typeof fields.number === "string" ? normalizeCertificateNumber(fields.number) : null;
    if (!number) throw new SiwsError(400, "Enter a certificate number such as MC-2026-0001");
    let provided: string | null = null;
    if (fields.sha256 !== undefined && fields.sha256 !== null && fields.sha256 !== "") {
      provided = typeof fields.sha256 === "string" ? normalizeSha256Input(fields.sha256) : null;
      if (!provided) throw new SiwsError(400, "The SHA-256 must be 64 hex characters");
    }
    if ((await consumeSharedRateLimit(`certificate-verify:${ipKey}`, SHARED_LIMIT, SHARED_WINDOW_SECONDS)) === "limited") {
      throw new SiwsError(429, "Too many checks from this address — try again in a few minutes");
    }

    const { data, error } = await getSupabaseAdmin()
      .from("certificates")
      .select(PUBLIC_CERTIFICATE_COLUMNS)
      .eq("network", detectNetwork())
      .eq("number", number)
      .limit(1);
    if (error) throw certificatesUnavailable(error);
    const row = ((data ?? []) as unknown as PublicRow[])[0];
    if (!row) return NextResponse.json({ ok: true, data: { found: false, number, hash_matches: null } }, { headers });

    const hashConsistent = (await sha256HexOfText(row.payload_canonical)) === row.payload_sha256;
    let signatureValid = false;
    if (row.signature && row.signature_format) {
      try {
        const format = await certificateSignatureFormat(
          certificateMessage(row.number, row.payload_sha256),
          row.signer,
          row.signature,
          row.signature_format,
        );
        signatureValid = format === row.signature_format;
      } catch {
        throw new SiwsError(503, "Signature verification unavailable — try again");
      }
    }
    const view = publicCertificateView(row, { signatureValid, hashConsistent, providedSha256: provided });
    return NextResponse.json({ ok: true, data: view }, { headers });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
