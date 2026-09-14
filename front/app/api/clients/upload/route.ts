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
// Side effects: client_documents row insert; when requirement_id is given the
// requirement flips to `submitted` with the document linked, and the parent
// client's kyc_status is recomputed (more_info → pending when nothing open).
//
// Reads are NOT served from here — see /api/clients/doc-url (signed URLs).

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
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
      await fetchClientOr404(sb, clientId);
    } else {
      // ── Magic-link mode: onboarding token is the credential ──────────────
      if (rateLimited(`upload:${clientIpOf(request)}`, 20, 60_000)) {
        throw new SiwsError(429, "Too many uploads — slow down");
      }
      clientId = assertUuid(formString(form, "client_id"), "client_id");
      const clientRow = await requireClientToken(sb, clientId, formString(form, "token"));
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
