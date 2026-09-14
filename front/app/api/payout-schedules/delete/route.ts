// POST /api/payout-schedules/delete — remove one payout_schedules row by id.
// Signed (SIWS) + on-chain admin gate.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(
      request,
      "payoutSchedules.delete",
    );
    await requireAdmin(wallet);

    const id = typeof params.id === "string" ? params.id : "";
    if (!UUID_RE.test(id)) throw new SiwsError(400, "id must be a UUID");

    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("payout_schedules")
      .delete()
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (error) {
      console.error(
        "[api/payout-schedules/delete] delete failed:",
        error.message,
      );
      throw new SiwsError(500, "Could not remove the schedule");
    }
    if (!data) throw new SiwsError(404, "Schedule not found");

    return NextResponse.json({ ok: true, data: { id } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
