// POST /api/compliance/list — admin read of AML/sanctions alerts.
//
// Signed + requireAdmin. compliance_alerts is the single most sensitive table
// in the schema (subject wallets, sanctions hit lists, screening evidence,
// resolver wallets and resolution notes — regulated AML data), so reads sit
// behind the on-chain admin gate exactly like fee_config/integrations reads.
// The residual anon SELECT policy is dropped in 0031: the shipped anon key
// can no longer dump the table.
//
// Client wrapper: listAlerts() in lib/compliance.ts (action "compliance.list").

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

export async function POST(request: Request) {
  try {
    const { wallet } = await verifySigned(request, "compliance.list");
    await requireAdmin(wallet);

    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("compliance_alerts")
      .select("*")
      .eq("network", detectNetwork())
      .order("created_at", { ascending: false });
    if (error) {
      console.error("[api/compliance/list] query failed:", error.message);
      throw new SiwsError(500, "Could not load compliance alerts");
    }

    return NextResponse.json({ ok: true, data: { alerts: data ?? [] } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
