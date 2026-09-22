// POST /api/clients/raise-limits — admin sets or clears a per-client
// ("case by case") override of the annual raise cap and/or max equity %.
// Signed ("clients.raiseLimits") + requireAdmin. Null fields fall back to
// the platform defaults; clear=true removes the override entirely.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { assertUuid, fetchClientOr404, insertNote, optString } from "../_helpers";

function optAmount(v: unknown, field: string, min: number, max: number): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    throw new SiwsError(400, `${field} must be between ${min} and ${max}`);
  }
  return Math.round(v * 100) / 100;
}

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "clients.raiseLimits");
    await requireAdmin(wallet);
    const clientId = assertUuid(params.client_id, "client_id");
    const sb = getSupabaseAdmin();
    await fetchClientOr404(sb, clientId);
    if (params.clear === true) {
      const { error } = await sb.from("client_raise_limits").delete().eq("client_id", clientId);
      if (error) throw new SiwsError(500, "Could not clear the override");
      await insertNote(sb, clientId, wallet, "Raise limit override removed — platform defaults apply.", "system");
      return NextResponse.json({ ok: true, data: { override: null } });
    }
    const cap = optAmount(params.annual_raise_cap_eur, "Annual raise cap", 1, 1_000_000_000_000);
    const equity = optAmount(params.max_equity_percent, "Max equity %", 0.01, 100);
    if (cap === null && equity === null) throw new SiwsError(400, "Set a cap, a max equity %, or clear the override");
    const note = optString(params, "note", 1000);
    const { data, error } = await sb.from("client_raise_limits").upsert({
      client_id: clientId, annual_raise_cap_eur: cap, max_equity_percent: equity, note,
      updated_at: new Date().toISOString(), updated_by: wallet,
    }, { onConflict: "client_id" }).select("*").single();
    if (error) throw new SiwsError(500, "Could not save the override");
    await insertNote(sb, clientId, wallet,
      `Raise limit override: ${cap !== null ? `€${cap.toLocaleString("en-US")}/year` : "default cap"}, ${equity !== null ? `max ${equity}% equity` : "default equity"}${note ? ` — ${note}` : ""}.`, "system");
    return NextResponse.json({ ok: true, data: { override: data } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
