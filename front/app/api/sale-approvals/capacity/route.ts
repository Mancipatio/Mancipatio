// POST /api/sale-approvals/capacity — remaining rolling 12-month capacity of
// the subject behind a share class ("saleApprovals.capacity"; admin; a wallet
// session may authorize it). The subject is the asset's SPV, or the issuer
// when the asset has none. Also returns the highest sale id reserved for the
// share class, so the approve form can suggest the next free one.
// Params: share_class.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { addressParam, saleCapacity } from "@/lib/server/sale-capacity";
import { assetSpvId, shareClassChain, subjectOf } from "../_lib";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "saleApprovals.capacity");
    await requireAdmin(wallet);
    const shareClass = addressParam(params.share_class, "share_class");
    const sb = getSupabaseAdmin();
    const chain = await shareClassChain(shareClass);
    const spvId = await assetSpvId(sb, chain.asset);
    const subject = subjectOf(spvId, chain.issuer);
    const capacity = await saleCapacity(sb, subject);
    const { data, error } = await sb.from("sale_capacity_reservations").select("sale_id")
      .eq("network", detectNetwork()).eq("kind", "sale").eq("share_class_pda", shareClass)
      .order("sale_id", { ascending: false }).limit(1);
    if (error) throw new SiwsError(503, "Could not load the reservations");
    const maxReserved = data?.[0]?.sale_id;
    return NextResponse.json({
      ok: true,
      data: {
        subject, spv_id: spvId, issuer: chain.issuer, asset: chain.asset, issuer_authority: chain.authority,
        issuer_verified: chain.issuerVerified, capacity,
        max_reserved_sale_id: maxReserved === undefined || maxReserved === null ? null : String(maxReserved),
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
