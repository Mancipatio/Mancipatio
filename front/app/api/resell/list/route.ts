// POST /api/resell/list — the seller's own listing history (scope "mine") or
// the admin board (scope "admin"), read on the service role. Since 0082 the
// browser roles read ACTIVE listings only, so a matched, withdrawn or removed
// post — and its seller contact — is readable here alone. Signed (SIWS):
// "mine" is bound to the VERIFIED signer (a caller-supplied wallet is
// ignored); "admin" passes the on-chain admin gate before any database
// access. A read: no module switch, so the exits of an existing listing
// (withdraw, mark matched, restore) stay reachable in every mode. Modelled
// on /api/otc/list.

import { NextResponse } from "next/server";
import { verifySigned, SiwsError, siwsErrorResponse } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

// Every column of resell_listings (0022) except the moderation stamps, which
// only the admin board reads.
const MINE_COLUMNS = "id,created_at,updated_at,network,seller_wallet,mint,share_class_pda,asset_pda,asset_label,amount,ask_price,ask_currency,note,contact,status,linked_offer_pda";
const STATUSES = new Set(["active", "matched", "withdrawn", "removed"]);
export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "resell.list");
    const admin = params.scope === "admin";
    if (params.scope !== "mine" && !admin) throw new SiwsError(400, "Invalid scope");
    if (admin) await requireAdmin(wallet);
    if (params.status !== undefined && !STATUSES.has(String(params.status))) throw new SiwsError(400, "Invalid status");
    const offset = params.offset ?? 0;
    if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > 1_000_000) throw new SiwsError(400, "Invalid page");
    let query = getSupabaseAdmin().from("resell_listings").select(admin ? "*" : MINE_COLUMNS)
      .eq("network", detectNetwork()).order("created_at", { ascending: false }).order("id", { ascending: false })
      .range(Number(offset), Number(offset) + 99);
    if (!admin) query = query.eq("seller_wallet", wallet);
    if (params.status !== undefined) query = query.eq("status", String(params.status));
    const { data, error } = await query;
    if (error) throw new SiwsError(503, "Listings unavailable — try again");
    return NextResponse.json({ ok: true, data: data ?? [] }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) { return siwsErrorResponse(err); }
}
