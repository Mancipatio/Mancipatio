import { NextResponse } from "next/server";
import { verifySigned, SiwsError, siwsErrorResponse } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

const PARTY_COLUMNS = "id,created_at,updated_at,network,share_class_pda,mint,asset_label,seller_wallet,buyer_wallet,amount,price,payment_mint,requested_by,status,deal_pda,deal_id,expires_at";
const STATUSES = new Set(["requested", "created", "cancelled", "completed", "expired"]);
export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "otc.list");
    const admin = params.scope === "admin";
    if (params.scope !== "mine" && !admin) throw new SiwsError(400, "Invalid scope");
    if (admin) await requireAdmin(wallet);
    if (params.status !== undefined && !STATUSES.has(String(params.status))) throw new SiwsError(400, "Invalid status");
    const offset = params.offset ?? 0;
    if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > 1_000_000) throw new SiwsError(400, "Invalid page");
    let query = getSupabaseAdmin().from("otc_requests").select(admin ? "*" : PARTY_COLUMNS)
      .eq("network", detectNetwork()).order("created_at", { ascending: false }).order("id", { ascending: false })
      .range(Number(offset), Number(offset) + 99);
    if (!admin) query = query.or(`seller_wallet.eq.${wallet},buyer_wallet.eq.${wallet}`);
    if (params.status !== undefined) query = query.eq("status", params.status);
    const { data, error } = await query;
    if (error) throw new SiwsError(503, "OTC requests unavailable — try again");
    return NextResponse.json({ ok: true, data: data ?? [] }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) { return siwsErrorResponse(err); }
}
