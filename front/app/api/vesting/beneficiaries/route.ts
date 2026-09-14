import { NextResponse } from "next/server";
import { verifySigned, SiwsError, siwsErrorResponse } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { requireVestingEditor, UUID_RE } from "@/app/api/vesting/_lib";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "vesting.beneficiaries");
    const id = typeof params.schedule_id === "string" ? params.schedule_id : "";
    if (!UUID_RE.test(id)) throw new SiwsError(400, "Invalid schedule id");
    let canManage = false;
    try { await requireVestingEditor(wallet, id); canManage = true; }
    catch (err) { if (!(err instanceof SiwsError && err.status === 403)) throw err; }
    // Legacy schedules have no network column. Authorization uses the existing
    // author/issuer/admin circle; other wallets see only their own proof.
    const offset = params.offset ?? 0;
    if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > 1_000_000) throw new SiwsError(400, "Invalid page");
    let query = getSupabaseAdmin().from("vesting_beneficiaries")
      .select("schedule_id,wallet,entitlement,merkle_index,merkle_proof")
      .eq("schedule_id", id).order("merkle_index", { ascending: true })
      .range(Number(offset), Number(offset) + 99);
    if (!canManage) query = query.eq("wallet", wallet);
    const { data, error } = await query;
    if (error) throw new SiwsError(503, "Beneficiaries unavailable — try again");
    return NextResponse.json({ ok: true, data: { beneficiaries: data ?? [], can_manage: canManage } }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) { return siwsErrorResponse(err); }
}
