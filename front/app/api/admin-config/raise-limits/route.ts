// POST /api/admin-config/raise-limits — admin read ("adminConfig.raiseLimitsRead")
// or update ("adminConfig.raiseLimitsUpdate", op "update") of the platform
// raise limits for the active network: annual cap per applicant per calendar
// year (EUR) and max equity % per application. Signed + requireAdmin.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

function amount(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    throw new SiwsError(400, `${field} must be between ${min} and ${max}`);
  }
  return Math.round(v * 100) / 100;
}

export async function POST(request: Request) {
  try {
    const body = await request.clone().json().catch(() => null) as { payload?: { action?: unknown } } | null;
    const isUpdate = body?.payload?.action === "adminConfig.raiseLimitsUpdate";
    const { wallet, params } = await verifySigned(request, isUpdate ? "adminConfig.raiseLimitsUpdate" : "adminConfig.raiseLimitsRead");
    await requireAdmin(wallet);
    const sb = getSupabaseAdmin();
    const network = detectNetwork();
    if (isUpdate) {
      const row = {
        network,
        annual_raise_cap_eur: amount(params.annual_raise_cap_eur, "Annual raise cap", 1, 1_000_000_000_000),
        max_equity_percent: amount(params.max_equity_percent, "Max equity %", 0.01, 100),
        updated_at: new Date().toISOString(), updated_by: wallet,
      };
      const { error } = await sb.from("platform_raise_limits").upsert(row, { onConflict: "network" });
      if (error) throw new SiwsError(500, "Could not save the raise limits");
    }
    const { data, error } = await sb.from("platform_raise_limits").select("*").eq("network", network).maybeSingle();
    if (error) throw new SiwsError(500, "Could not load the raise limits");
    return NextResponse.json({ ok: true, data: data ?? { network, annual_raise_cap_eur: 3000000, max_equity_percent: 100, updated_at: null, updated_by: null } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
