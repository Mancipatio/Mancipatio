// POST /api/fees/config-upsert — add/edit one fee_config row.
// Signed (SIWS) + on-chain admin gate. Network is stamped server-side;
// conflict target mirrors the table's unique (network, fee_type, recipient).

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

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "fees.configUpsert");
    await requireAdmin(wallet);

    const feeType = typeof params.fee_type === "string" ? params.fee_type : "";
    if (!FEE_TYPES.has(feeType)) {
      throw new SiwsError(400, "Unknown fee_type");
    }
    const rateBps = params.rate_bps;
    if (
      typeof rateBps !== "number" ||
      !Number.isInteger(rateBps) ||
      rateBps < 0 ||
      rateBps > 10000
    ) {
      throw new SiwsError(400, "rate_bps must be an integer between 0 and 10000");
    }
    const recipient =
      typeof params.recipient === "string" ? params.recipient.trim() : "";
    if (!BASE58_RE.test(recipient)) {
      throw new SiwsError(400, "recipient must be a base58 Solana address");
    }
    const shareBps = params.share_bps;
    if (
      typeof shareBps !== "number" ||
      !Number.isInteger(shareBps) ||
      shareBps < 1 ||
      shareBps > 10000
    ) {
      throw new SiwsError(400, "share_bps must be an integer between 1 and 10000");
    }
    const label = typeof params.label === "string" ? params.label.trim() : "";
    if (label.length > 120) {
      throw new SiwsError(400, "label must be at most 120 characters");
    }
    if (typeof params.enabled !== "boolean") {
      throw new SiwsError(400, "enabled must be a boolean");
    }

    const sb = getSupabaseAdmin();
    const { error } = await sb.from("fee_config").upsert(
      {
        network: detectNetwork(),
        fee_type: feeType,
        rate_bps: rateBps,
        recipient,
        share_bps: shareBps,
        label,
        enabled: params.enabled,
      },
      { onConflict: "network,fee_type,recipient" },
    );
    if (error) {
      console.error("[api/fees/config-upsert] upsert failed:", error.message);
      throw new SiwsError(500, "Could not save the fee");
    }

    return NextResponse.json({ ok: true, data: { fee_type: feeType, recipient } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
