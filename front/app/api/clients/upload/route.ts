// POST /api/clients/upload — KYC document upload into the PRIVATE
// "client-documents" bucket via the service-role client (never the anon key).
//
// multipart/form-data with TWO auth modes:
//   * ADMIN  — field `auth` = JSON SiwsRequestBody signed for action
//     "clients.upload" with params { client_id, kind, sha256, size,
//     requirement_id? }. The server recomputes the file's SHA-256 and requires
//     it to equal the signed one — the signature is bound to the exact bytes.
//     (verifySigned consumes request.json(), so the envelope is replayed
//     through a synthetic Request; the multipart body itself is not signed.)
//   * MAGIC-LINK — fields `client_id`, `token`, `kind`, optional
//     `requirement_id`. Token validated against clients.onboarding_token
//     (incl. TTL); uploaded_by is the VALIDATED row's linked wallet (a
//     `wallet` form field, if sent, is ignored — form input must not shape
//     the audit trail). Per-IP rate limited.
//
// Both modes are refused with 503 while the network is in maintenance.
//
// Side effects: client_documents row insert; when requirement_id is given the
// requirement flips to `submitted` with the document linked, and the parent
// client's kyc_status is recomputed (more_info → pending when nothing open).
//
// Erasure race: an upload that overlaps /api/clients/anonymize (the file is
// stored after the erasure listed the dossier's files, and the row insert —
// which waits on anonymize_client's lock on the clients row — commits after
// it) would leave a document on an erased dossier. clients.anonymized_at is
// read when the upload starts and again after the row is written; if it
// moved, the upload is rolled back (row and file deleted) and answered 409.
// A dossier erased BEFORE the upload started takes new documents normally
// (re-verification).
//
// Reads are NOT served from here — see /api/clients/doc-url (signed URLs).

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { assertWritable } from "@/lib/server/maintenance";
import { detectNetwork } from "@/lib/network";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import {
  MAX_UPLOAD_BYTES,
  PRIVATE_BUCKET,
  assertUuid,
  fetchClientOr404,
  clientIpOf,
  rateLimited,
  recomputeKycFromRequirements,
  requireClientToken,
  safePathSegment,
  sha256HexOf,
} from "../_helpers";

function formString(form: FormData, key: string): string | null {
  const v = form.get(key);
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Re-read clients.anonymized_at after the document row is written (the
 * insert waited for any erasure holding the dossier's row lock, so this read
 * sees it). When it differs from the value at the start — or cannot be read —
 * delete the row and the file and refuse: fail closed, the client retries.
 */
async function rollBackIfErasedMeanwhile(
  sb: ReturnType<typeof getSupabaseAdmin>,
  clientId: string,
  erasedAtStart: unknown,
  documentId: number,
  storagePath: string,
): Promise<void> {
  const { data, error } = await sb.from("clients").select("*").eq("id", clientId).maybeSingle();
  const erasedNow = (data as { anonymized_at?: unknown } | null)?.anonymized_at ?? null;
  if (!error && data && erasedNow === erasedAtStart) return;

  const { error: rowErr } = await sb.from("client_documents").delete().eq("id", documentId);
  // The path is content-addressed, so an identical earlier upload may share
  // it: the file goes only when no other document row points at it (after an
  // erasure there is none). When that cannot be checked, the file stays — the
  // next Anonymize run deletes unreferenced files under the dossier's prefix.
  const { data: others, error: othersErr } = await sb
    .from("client_documents")
    .select("id")
    .eq("storage_path", storagePath)
    .neq("id", documentId)
    .limit(1);
  let fileErr: unknown = othersErr;
  if (!othersErr && (others ?? []).length === 0) {
    ({ error: fileErr } = await sb.storage.from(PRIVATE_BUCKET).remove([storagePath]));
  }
  if (rowErr || fileErr) {
    console.error(
      `[api/clients/upload] rollback after erasure incomplete for ${clientId} (row: ${rowErr ? "failed" : "ok"}, file: ${fileErr ? "kept" : "ok"}) — run Anonymize again`,
    );
  }
  if (error || !data) {
    throw new SiwsError(503, "Could not confirm the upload — nothing was kept; try again");
  }
  throw new SiwsError(
    409,
    "This dossier's personal data was erased while the file was uploading — nothing was kept. Upload it again if it is still needed.",
  );
}

export async function POST(request: Request) {
  try {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new SiwsError(400, "Expected multipart/form-data");
    }

    const file = form.get("file");
    if (!(file instanceof File)) throw new SiwsError(400, "Missing file");
    if (file.size === 0) throw new SiwsError(400, "Empty file");
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new SiwsError(400, "File exceeds the 15 MB limit");
    }

    const buf = await file.arrayBuffer();
    const sha = await sha256HexOf(buf);

    const sb = getSupabaseAdmin();

    let clientId: string;
    let kind: string;
    let uploadedBy: string;
    let requirementId: number | null = null;
    // clients.anonymized_at when the upload started (null = never erased, or
    // a database without migration 0065).
    let erasedAtStart: unknown;

    const authRaw = formString(form, "auth");
    if (authRaw) {
      // ── Admin mode: verify the SIWS envelope carried in the `auth` field ──
      const synthetic = new Request(request.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(request.headers.has("origin")
            ? { origin: request.headers.get("origin")! }
            : {}),
        },
        body: authRaw,
      });
      const { wallet, params } = await verifySigned(synthetic, "clients.upload");
      await requireAdmin(wallet);

      clientId = assertUuid(params.client_id, "client_id");
      if (typeof params.kind !== "string" || params.kind.length === 0 || params.kind.length > 40) {
        throw new SiwsError(400, "kind must be a 1–40 character string");
      }
      kind = params.kind;
      if (params.sha256 !== sha) {
        throw new SiwsError(401, "File hash does not match the signed payload");
      }
      if (typeof params.size === "number" && params.size !== file.size) {
        throw new SiwsError(401, "File size does not match the signed payload");
      }
      if (params.requirement_id !== undefined && params.requirement_id !== null) {
        if (
          typeof params.requirement_id !== "number" ||
          !Number.isInteger(params.requirement_id) ||
          params.requirement_id <= 0
        ) {
          throw new SiwsError(400, "requirement_id must be a positive integer");
        }
        requirementId = params.requirement_id;
      }
      uploadedBy = wallet;

      // The admin's authority and the dossier must belong to this network.
      erasedAtStart = (await fetchClientOr404(sb, clientId)).anonymized_at ?? null;
    } else {
      // ── Magic-link mode: onboarding token is the credential ──────────────
      if (rateLimited(`upload:${clientIpOf(request)}`, 20, 60_000)) {
        throw new SiwsError(429, "Too many uploads — slow down");
      }
      // No signature, so verifySigned never runs: refuse maintenance here,
      // before any storage or database write (admin mode is refused there).
      await assertWritable(detectNetwork());
      clientId = assertUuid(formString(form, "client_id"), "client_id");
      const clientRow = await requireClientToken(sb, clientId, formString(form, "token"));
      erasedAtStart = clientRow.anonymized_at ?? null;
      const kindRaw = formString(form, "kind");
      if (!kindRaw || kindRaw.length > 40) {
        throw new SiwsError(400, "kind must be a 1–40 character string");
      }
      kind = kindRaw;
      // uploaded_by comes from the VALIDATED client row, never from the form —
      // a bearer of the token could otherwise stamp an arbitrary wallet into
      // the audit trail (any `wallet` form field is deliberately ignored).
      uploadedBy = clientRow.wallet ?? "client";
      const reqIdRaw = formString(form, "requirement_id");
      if (reqIdRaw) {
        const parsed = Number(reqIdRaw);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new SiwsError(400, "requirement_id must be a positive integer");
        }
        requirementId = parsed;
      }
    }

    // When linking to a requirement, it must belong to this client.
    if (requirementId != null) {
      const { data: reqRow, error: reqErr } = await sb
        .from("kyc_requirements")
        .select("id, client_id")
        .eq("id", requirementId)
        .maybeSingle();
      if (reqErr) throw new SiwsError(500, "Database read failed");
      if (!reqRow || (reqRow as { client_id: string }).client_id !== clientId) {
        throw new SiwsError(404, "Requirement not found for this client");
      }
    }

    // MIME allowlist (defense in depth): only document/image types are valid
    // KYC uploads. Rejecting text/html etc. prevents a stored-HTML file from
    // ever being served from the storage origin. Mirrors the bucket allowlist
    // in migration 0031.
    const ALLOWED_MIME = new Set([
      "application/pdf",
      "image/png",
      "image/jpeg",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ]);
    const mime = file.type || "application/octet-stream";
    if (!ALLOWED_MIME.has(mime)) {
      throw new SiwsError(
        400,
        "Unsupported file type — upload a PDF, PNG, JPG or DOCX",
      );
    }

    // ── Store bytes in the PRIVATE bucket + record metadata ────────────────
    const safeKind = safePathSegment(kind);
    const safeName = safePathSegment(file.name || "document");
    const storagePath = `clients/${clientId}/${safeKind}/${sha.slice(0, 8)}-${safeName}`;

    const { error: upErr } = await sb.storage
      .from(PRIVATE_BUCKET)
      .upload(storagePath, buf, {
        cacheControl: "3600",
        upsert: false,
        contentType: mime,
      });
    // "already exists" for an identical content-hash path is effectively a
    // no-op re-upload; anything else is fatal.
    if (upErr && !/already exists|duplicate/i.test(upErr.message)) {
      console.warn("[api/clients/upload] storage failed:", upErr.message);
      throw new SiwsError(500, "Storage upload failed: " + upErr.message);
    }

    const { data: doc, error: docErr } = await sb
      .from("client_documents")
      .insert({
        client_id: clientId,
        kind,
        storage_path: storagePath,
        sha256: sha,
        uploaded_by: uploadedBy,
        size_bytes: file.size,
      })
      .select("id")
      .single();
    if (docErr || !doc) {
      console.warn("[api/clients/upload] row insert failed:", docErr?.message);
      throw new SiwsError(500, "Document record insert failed");
    }
    const documentId = (doc as { id: number }).id;

    // Erased while this upload ran? Then nothing of it may stay.
    await rollBackIfErasedMeanwhile(sb, clientId, erasedAtStart, documentId, storagePath);

    let recomputed: string | null = null;
    if (requirementId != null) {
      const { error: flipErr } = await sb
        .from("kyc_requirements")
        .update({
          status: "submitted",
          document_id: documentId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", requirementId);
      if (flipErr) {
        console.warn("[api/clients/upload] requirement flip failed:", flipErr.message);
      } else {
        recomputed = await recomputeKycFromRequirements(sb, clientId);
      }
    }

    return NextResponse.json({
      ok: true,
      data: { document_id: documentId, sha256: sha, recomputed },
    });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
