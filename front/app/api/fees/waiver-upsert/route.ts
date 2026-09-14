// POST /api/fees/waiver-upsert — add/edit one fee_waivers row.
// Signed (SIWS) + on-chain admin gate. granted_by is stamped with the
// VERIFIED signer wallet server-side (any client-sent value is ignored);
// network is stamped server-side. Conflict target mirrors the table's
// unique (network, client_id, fee_type).

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

const FEE_TYPES = new Set([
  "issuance",
  "sale",
  "otc",
  "conversion",
  "withdrawal",
  "mint",
  "governance",
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "fees.waiverUpsert");
    await requireAdmin(wallet);

    const clientId = typeof params.client_id === "string" ? params.client_id : "";
    if (!UUID_RE.test(clientId)) {
      throw new SiwsError(400, "client_id must be a UUID");
    }
    const feeType = typeof params.fee_type === "string" ? params.fee_type : "";
    if (!FEE_TYPES.has(feeType)) {
      throw new SiwsError(400, "Unknown fee_type");
    }
    const overrideBps = params.override_bps;
    if (
      typeof overrideBps !== "number" ||
      !Number.isInteger(overrideBps) ||
      overrideBps < 0 ||
      overrideBps > 10000
    ) {
      throw new SiwsError(
        400,
        "override_bps must be an integer between 0 and 10000",
      );
    }
    let expiresAt: string | null = null;
    if (params.expires_at !== undefined && params.expires_at !== null) {
      if (
        typeof params.expires_at !== "string" ||
        Number.isNaN(Date.parse(params.expires_at))
      ) {
        throw new SiwsError(400, "expires_at must be an ISO timestamp or null");
      }
      expiresAt = new Date(params.expires_at).toISOString();
    }
    const reason = typeof params.reason === "string" ? params.reason.trim() : "";
    if (reason.length > 500) {
      throw new SiwsError(400, "reason must be at most 500 characters");
    }

    const sb = getSupabaseAdmin();
    const { error } = await sb.from("fee_waivers").upsert(
      {
        network: detectNetwork(),
        client_id: clientId,
        fee_type: feeType,
        override_bps: overrideBps,
        expires_at: expiresAt,
        reason,
        granted_by: wallet,
      },
      { onConflict: "network,client_id,fee_type" },
    );
    if (error) {
      // 23503 = client_id doesn't reference an existing clients row.
      if (error.code === "23503") {
        throw new SiwsError(400, "Unknown client");
      }
      console.error("[api/fees/waiver-upsert] upsert failed:", error.message);
      throw new SiwsError(500, "Could not save the waiver");
    }

    return NextResponse.json({
      ok: true,
      data: { client_id: clientId, fee_type: feeType },
    });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
