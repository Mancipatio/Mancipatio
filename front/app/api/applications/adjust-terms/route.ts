// POST /api/applications/adjust-terms — admin sets the raise amount and the
// equity % of one application ("case by case"). Signed
// ("applications.adjustTerms") + requireAdmin. The database trigger still
// enforces the applicant's yearly cap and max equity; raise the client's
// limit first when a case needs more.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { insertApplicationEvent } from "../_lib";
import { raiseLimitError } from "@/lib/server/raise-limits";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "applications.adjustTerms");
    await requireAdmin(wallet);
    const id = typeof params.id === "string" && UUID_RE.test(params.id) ? params.id : null;
    if (!id) throw new SiwsError(400, "id is required");
    const raise = params.raise_amount;
    const equity = params.equity_offered;
    if (typeof raise !== "number" || !Number.isFinite(raise) || raise < 1 || raise > 1_000_000_000_000) throw new SiwsError(400, "raise_amount must be a positive EUR amount");
    if (typeof equity !== "number" || !Number.isFinite(equity) || equity < 0.01 || equity > 100) throw new SiwsError(400, "equity_offered must be between 0.01 and 100");
    const note = typeof params.note === "string" ? params.note.trim().slice(0, 1000) : "";

    const sb = getSupabaseAdmin();
    const { data: before, error: readErr } = await sb.from("launch_applications")
      .select("raise_amount,equity_offered").eq("id", id).eq("network", detectNetwork()).maybeSingle();
    if (readErr) throw new SiwsError(500, "Could not load the application");
    if (!before) throw new SiwsError(404, "Application not found");
    const { error } = await sb.from("launch_applications")
      .update({ raise_amount: raise, equity_offered: equity }).eq("id", id).eq("network", detectNetwork());
    const limit = raiseLimitError(error);
    if (limit) throw new SiwsError(400, `${limit.message} Raise the client's limit on the client page first.`);
    if (error) throw new SiwsError(500, "Could not update the terms");
    await insertApplicationEvent(sb, {
      application_id: id, actor: "admin", action: "terms_adjusted", actor_wallet: wallet,
      reason: `Raise €${Number(before.raise_amount).toLocaleString("en-US")} → €${raise.toLocaleString("en-US")}, equity ${before.equity_offered}% → ${equity}%${note ? ` — ${note}` : ""}`,
    });
    return NextResponse.json({ ok: true, data: { raise_amount: raise, equity_offered: equity } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
