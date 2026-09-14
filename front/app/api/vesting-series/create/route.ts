// POST /api/vesting-series/create — client submits a vesting series request
// (spec §11.1.2). Signed (SIWS); the signer must be a KYC-verified client
// (spec §11.1.1 — server re-checks, never trusts the UI). The team reviews
// the request in /admin/vesting; only after approval can the client create
// the on-chain series.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { requireVerifiedClient } from "@/lib/server/kyc-gate";
import { requireSupportedVestingMint } from "@/lib/server/vesting-mint-gate";
import { getServerRpc } from "@/lib/server/rpc";
import { detectNetwork } from "@/lib/network";
import { validateSeriesForm } from "../_lib";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(
      request,
      "vesting-series.create",
    );
    const sb = getSupabaseAdmin();
    const { clientId } = await requireVerifiedClient(
      sb,
      wallet,
      "creating a vesting series",
    );

    const form = validateSeriesForm(params);
    // Same rules prepare-creation applies (F05): a request for a mint the
    // vesting flow cannot escrow must not enter review at all — the API is
    // reachable without the form's input-time check.
    await requireSupportedVestingMint(getServerRpc(), form.tokenMint, "submission");

    const { data, error } = await sb
      .from("vesting_series")
      .insert({
        network: detectNetwork(),
        client_wallet: wallet,
        client_id: clientId,
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
      })
      .select("id")
      .single();
    if (error || !data) {
      console.error(
        "[api/vesting-series/create] insert failed:",
        error?.message,
      );
      throw new SiwsError(500, "Could not save the vesting series request");
    }

    await sb.from("vesting_series_events").insert({
      series_id: data.id,
      actor: "client",
      action: "submitted",
      actor_wallet: wallet,
    });

    return NextResponse.json({ ok: true, data: { id: data.id as string } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
