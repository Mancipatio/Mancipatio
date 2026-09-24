// POST /api/spvs/issuances — admin read of an SPV's issuance ledger
// ("spvs.issuances"; a wallet session may authorize it; Talas 5.1): every
// row with its source (sale / treasury_mint booked by the server, manual
// adjustments with their reason code) and issue date. Replaces the anonymous
// spv_issuances read that migration 0074 removes. Params: spv_id.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { UUID_RE } from "@/lib/server/sale-capacity";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "spvs.issuances");
    await requireAdmin(wallet);
    if (typeof params.spv_id !== "string" || !UUID_RE.test(params.spv_id)) throw new SiwsError(400, "spv_id must be a UUID");
    const sb = getSupabaseAdmin();
    const spv = await sb.from("spvs").select("id").eq("id", params.spv_id).eq("network", detectNetwork()).maybeSingle();
    if (spv.error) throw new SiwsError(503, "Could not load the SPV");
    if (!spv.data) throw new SiwsError(404, "SPV not found");
    const { data, error } = await sb.from("spv_issuances")
      .select("id,created_at,spv_id,asset_pda,sale_pubkey,amount_eur,issued_at,note,recorded_by,source,cap_override,reason_code")
      .eq("spv_id", params.spv_id).order("issued_at", { ascending: false }).limit(500);
    if (error) throw new SiwsError(503, "Could not load the issuances");
    return NextResponse.json({ ok: true, data: data ?? [] }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
