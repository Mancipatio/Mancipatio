import { detectNetwork } from "@/lib/network";
// POST /api/vesting-series/update — client resubmits a series the team sent
// back for fixes (needs_changes → submitted). Signed; owner-bound; the
// status-transition trigger enforces the legal move.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { requireSupportedVestingMint } from "@/lib/server/vesting-mint-gate";
import { getServerRpc } from "@/lib/server/rpc";
import { validateSeriesForm } from "../_lib";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(
      request,
      "vesting-series.update",
    );
    const id = typeof params.id === "string" ? params.id : "";
    if (id.length === 0) throw new SiwsError(400, "id is required");
    const form = validateSeriesForm(params);
    // A resubmission may change the mint; same pre-review gate as `create`.
    await requireSupportedVestingMint(getServerRpc(), form.tokenMint, "submission");

    const sb = getSupabaseAdmin();
    const { data: row, error: readErr } = await sb
      .from("vesting_series")
      .select("id, client_wallet, status")
      .eq("id", id)
      .eq("network", detectNetwork())
      .maybeSingle();
    if (readErr) throw new SiwsError(500, "Series lookup failed");
    if (!row || row.client_wallet !== wallet) {
      throw new SiwsError(404, "Vesting series not found");
    }
    if (row.status !== "needs_changes") {
      throw new SiwsError(
        409,
        "Only a series sent back for fixes can be resubmitted",
      );
    }

    const { data: updated, error } = await sb
      .from("vesting_series")
      .update({
        token_mint: form.tokenMint,
        token_label: form.tokenLabel,
        timing_mode: form.timingMode,
        delivery_mode: form.deliveryMode,
        approval_window_secs: form.approvalWindowSecs,
        recovery_enabled: form.recoveryEnabled,
        cancellation_enabled: form.cancellationEnabled,
        pre_cliff_bps: form.preCliffBps,
        schedule: form.schedule,
        recipients: form.recipients,
        status: "submitted",
        review_reason: null,
      })
      .eq("id", id)
      .eq("network", detectNetwork())
      .eq("client_wallet", wallet)
      .eq("status", "needs_changes")
      .select("id")
      .maybeSingle();
    if (error) {
      console.error(
        "[api/vesting-series/update] update failed:",
        error.message,
      );
      throw new SiwsError(500, "Could not resubmit the vesting series");
    }

    if (!updated)
      throw new SiwsError(409, "Series changed; reload before resubmitting");
    await sb.from("vesting_series_events").insert({
      series_id: id,
      actor: "client",
      action: "resubmitted",
      actor_wallet: wallet,
    });

    return NextResponse.json({ ok: true, data: { id } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
