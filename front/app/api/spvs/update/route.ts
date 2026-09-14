// POST /api/spvs/update — patch an SPV row (admin registry), incl. retiring
// (status -> "retired"; the UI's ConfirmModal reason lands in the audit log
// client-side, as before).
//
// Signed route, platform-admin only. Client wrapper: updateSpv() in
// lib/spvs.ts (action "spvs.update"). Patch keys are allowlisted; `network`
// and timestamps are never patchable.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = new Set(["planned", "incorporating", "active", "retired"]);

/** Patchable columns (everything else is rejected). */
const PATCH_KEYS = new Set([
  "name",
  "registration_number",
  "country",
  "status",
  "client_id",
  "issuer_pda",
  "incorporated_at",
  "notes",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "spvs.update");
    await requireAdmin(wallet);

    const id = typeof params.id === "string" ? params.id.trim() : "";
    if (!UUID_RE.test(id)) {
      throw new SiwsError(400, "id must be a UUID");
    }
    if (!isPlainObject(params.patch)) {
      throw new SiwsError(400, "Missing patch");
    }

    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params.patch)) {
      if (!PATCH_KEYS.has(key)) {
        throw new SiwsError(400, `Field "${key}" is not patchable`);
      }
      patch[key] = value;
    }
    if (Object.keys(patch).length === 0) {
      throw new SiwsError(400, "Empty patch");
    }

    if ("name" in patch) {
      const name = typeof patch.name === "string" ? patch.name.trim() : "";
      if (!name || name.length > 200) {
        throw new SiwsError(400, "name required (≤200 chars)");
      }
      patch.name = name;
    }
    if ("registration_number" in patch && patch.registration_number !== null) {
      if (
        typeof patch.registration_number !== "string" ||
        patch.registration_number.length > 100
      ) {
        throw new SiwsError(400, "registration_number invalid");
      }
    }
    if ("country" in patch) {
      if (
        typeof patch.country !== "string" ||
        !/^\d{1,3}$/.test(patch.country)
      ) {
        throw new SiwsError(400, "country must be an ISO numeric code");
      }
    }
    if ("status" in patch) {
      if (typeof patch.status !== "string" || !STATUSES.has(patch.status)) {
        throw new SiwsError(400, "Unknown SPV status");
      }
    }
    if ("client_id" in patch && patch.client_id !== null) {
      if (typeof patch.client_id !== "string" || !UUID_RE.test(patch.client_id)) {
        throw new SiwsError(400, "client_id must be a UUID");
      }
    }
    if ("issuer_pda" in patch && patch.issuer_pda !== null) {
      if (
        typeof patch.issuer_pda !== "string" ||
        !BASE58_RE.test(patch.issuer_pda)
      ) {
        throw new SiwsError(400, "issuer_pda must be a base58 address");
      }
    }
    if ("incorporated_at" in patch && patch.incorporated_at !== null) {
      if (
        typeof patch.incorporated_at !== "string" ||
        !DATE_RE.test(patch.incorporated_at)
      ) {
        throw new SiwsError(400, "incorporated_at must be YYYY-MM-DD");
      }
    }
    if ("notes" in patch) {
      if (typeof patch.notes !== "string" || patch.notes.length > 5000) {
        throw new SiwsError(400, "notes invalid (≤5000 chars)");
      }
    }

    const sb = getSupabaseAdmin();
    const { error } = await sb.from("spvs").update(patch).eq("id", id);
    if (error) {
      console.error("[api/spvs/update] update failed:", error.message);
      throw new SiwsError(500, "SPV update failed");
    }

    return NextResponse.json({ ok: true, data: { id } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
