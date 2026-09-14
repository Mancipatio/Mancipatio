// POST /api/conversion/admin-update — admin lifecycle writes on a conversion
// request (open vault, confirm conversion, reject, return). Signed (SIWS) +
// on-chain admin gate. Status transitions are additionally pinned by the DB
// trigger from migration 0034 — an illegal jump surfaces as a 409 here.
// Mirror of /api/delivery/admin-update.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { validateCustodyUpdate } from "@/lib/server/custody-evidence";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// 'approved' is never produced (approval == opening the vault); 'requested'
// is never re-entered.
const ADMIN_STATUSES = new Set([
  "vault_opened",
  "deposited",
  "converted",
  "cancelled",
  "returned",
]);

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(
      request,
      "conversion.adminUpdate",
    );
    await requireAdmin(wallet);

    const id = typeof params.id === "string" ? params.id : "";
    if (id.length === 0 || id.length > 64) {
      throw new SiwsError(400, "id is required");
    }

    const patch: Record<string, unknown> = {};

    if (params.status !== undefined) {
      if (
        typeof params.status !== "string" ||
        !ADMIN_STATUSES.has(params.status)
      ) {
        throw new SiwsError(400, "status is not an allowed value");
      }
      patch.status = params.status;
    }
    if (params.vault_pda !== undefined) {
      if (
        typeof params.vault_pda !== "string" ||
        !BASE58_RE.test(params.vault_pda)
      ) {
        throw new SiwsError(400, "vault_pda is not a valid address");
      }
      patch.vault_pda = params.vault_pda;
    }
    if (params.vault_id !== undefined) {
      if (
        typeof params.vault_id !== "number" ||
        !Number.isSafeInteger(params.vault_id) ||
        params.vault_id < 0
      ) {
        throw new SiwsError(400, "vault_id must be a non-negative integer");
      }
      patch.vault_id = params.vault_id;
    }
    if (params.admin_note !== undefined) {
      if (params.admin_note === null) {
        patch.admin_note = null;
      } else if (
        typeof params.admin_note === "string" &&
        params.admin_note.length <= 2000
      ) {
        patch.admin_note = params.admin_note;
      } else {
        throw new SiwsError(400, "admin_note must be at most 2000 characters");
      }
    }
    for (const key of ["deposit_tx", "outcome_tx"] as const) {
      const v = params[key];
      if (v === undefined) continue;
      if (v === null) {
        patch[key] = null;
      } else if (typeof v === "string" && v.length <= 200) {
        patch[key] = v;
      } else {
        throw new SiwsError(400, `${key} must be at most 200 characters`);
      }
    }
    // decide: true stamps the decision fields with the verified admin wallet
    // (the client can never claim someone else decided).
    if (params.decide === true) {
      patch.decided_by = wallet;
      patch.decided_at = new Date().toISOString();
    }

    if (Object.keys(patch).length === 0) {
      throw new SiwsError(400, "Nothing to update");
    }

    const sb = getSupabaseAdmin();
    const previousStatus = await validateCustodyUpdate("conversion_requests", id, patch);
    const { data, error } = await sb
      .from("conversion_requests")
      .update(patch)
      .eq("id", id)
      .eq("network", detectNetwork())
      .eq("status", previousStatus)
      .select("id, status")
      .maybeSingle();
    if (error) {
      // The 0034 status-guard trigger raises on illegal transitions.
      const illegal = error.message.includes("illegal conversion status");
      console.warn(
        "[api/conversion/admin-update] update failed:",
        error.message,
      );
      throw new SiwsError(
        illegal ? 409 : 500,
        illegal ? error.message : "Could not update the conversion request",
      );
    }
    if (!data) throw new SiwsError(404, "Conversion request not found");

    return NextResponse.json({
      ok: true,
      data: { id: data.id as string, status: data.status as string },
    });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
