// POST /api/sale-approvals/list — admin read of capacity reservations
// ("saleApprovals.list"; a wallet session may authorize it).
// Params: application_id (uuid), share_class (address), adopted_treasury: true
// (treasury mints the ledger adopted at their floor, 0073) or manual: true (sale
// approvals without an application, the super admin's); optional `live`
// (only reserved / consumed rows).

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { UUID_RE, addressParam } from "@/lib/server/sale-capacity";
import { RESERVATION_FIELDS } from "../_lib";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "saleApprovals.list");
    await requireAdmin(wallet);
    let query = getSupabaseAdmin().from("sale_capacity_reservations").select(RESERVATION_FIELDS)
      .eq("network", detectNetwork()).order("created_at", { ascending: false }).limit(100);
    if (typeof params.application_id === "string") {
      if (!UUID_RE.test(params.application_id)) throw new SiwsError(400, "application_id must be a UUID");
      query = query.eq("application_id", params.application_id);
    } else if (params.manual === true) {
      query = query.eq("kind", "sale").is("application_id", null);
    } else if (params.adopted_treasury === true) {
      // Treasury mints nobody reserved, counted at their floor (0073): the super admin may re-value them.
      query = query.eq("kind", "treasury_mint").eq("adopted", true).eq("status", "booked");
    } else if (params.share_class !== undefined) {
      query = query.eq("share_class_pda", addressParam(params.share_class, "share_class"));
    } else {
      throw new SiwsError(400, "application_id or share_class is required");
    }
    if (params.live === true) query = query.in("status", ["reserved", "consumed"]);
    const { data, error } = await query;
    if (error) throw new SiwsError(503, "Could not load the reservations");
    return NextResponse.json({ ok: true, data: data ?? [] }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
