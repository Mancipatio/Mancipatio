import {
  hashVestingTerms,
  assertSupportedVestingTerms,
} from "@/lib/vesting-terms";
import { validateSeriesForm } from "../_lib";
import { detectNetwork } from "@/lib/network";
// POST /api/vesting-series/admin-review — team reviews a submitted series:
// approve / send back to fix / reject (spec §11.1.4). Signed + on-chain
// admin gate; the decision + reason are recorded and communicated (the
// client sees them in their issuer console).

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { requireSupportedVestingMint } from "@/lib/server/vesting-mint-gate";
import { getServerRpc } from "@/lib/server/rpc";
import { getSupabaseAdmin } from "@/lib/supabase-server";

const DECISIONS = new Set(["approved", "needs_changes", "rejected"]);

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(
      request,
      "vesting-series.admin-review",
    );
    await requireAdmin(wallet);

    const id = typeof params.id === "string" ? params.id : "";
    const decision = typeof params.decision === "string" ? params.decision : "";
    const reason =
      typeof params.reason === "string" ? params.reason.trim() : "";
    if (id.length === 0) throw new SiwsError(400, "id is required");
    if (!DECISIONS.has(decision)) {
      throw new SiwsError(
        400,
        "decision must be approved, needs_changes or rejected",
      );
    }
    if (decision !== "approved" && reason.length === 0) {
      throw new SiwsError(
        400,
        "a reason is required for needs_changes / rejected",
      );
    }
    if (reason.length > 2000) throw new SiwsError(400, "reason is too long");

    const sb = getSupabaseAdmin();
    const { data: row, error: readErr } = await sb
      .from("vesting_series")
      .select("*")
      .eq("id", id)
      .eq("network", detectNetwork())
      .maybeSingle();
    if (readErr) throw new SiwsError(500, "Series lookup failed");
    if (!row) throw new SiwsError(404, "Vesting series not found");
    const legacyApproval =
      row.status === "approved" && !row.approved_terms_hash && !row.series_pda;
    if (legacyApproval && decision === "rejected")
      throw new SiwsError(
        409,
        "Send the legacy approval back for changes before a rejection",
      );
    if (row.status !== "submitted" && !legacyApproval) {
      throw new SiwsError(409, "Only a submitted series can be reviewed");
    }

    let termsHash: string | null = null;
    if (decision === "approved") {
      validateSeriesForm(row);
      try {
        assertSupportedVestingTerms(row, Math.floor(Date.now() / 1000));
      } catch (error) {
        throw new SiwsError(
          400,
          error instanceof Error ? error.message : "Invalid terms",
        );
      }
      // Authoritative pre-approval gate (F05): approved terms are immutable,
      // so the mint's live token-program / extension / hook state is checked
      // NOW, not first at prepare-creation where a failure strands the
      // client in a request that can only be abandoned.
      await requireSupportedVestingMint(
        getServerRpc(),
        row.token_mint,
        "approval",
      );
      termsHash = await hashVestingTerms(row);
    }
    const { data: updated, error } = await sb
      .from("vesting_series")
      .update({
        status: decision,
        approved_terms_hash: termsHash,
        review_reason: reason.length > 0 ? reason : null,
        reviewed_by: wallet,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("network", detectNetwork())
      .eq("status", row.status)
      .eq("updated_at", row.updated_at)
      .select("id")
      .maybeSingle();
    if (error) {
      console.error(
        "[api/vesting-series/admin-review] update failed:",
        error.message,
      );
      throw new SiwsError(500, "Could not record the review decision");
    }

    if (!updated)
      throw new SiwsError(
        409,
        "Series changed during review; reload it before deciding",
      );
    await sb.from("vesting_series_events").insert({
      series_id: id,
      actor: "admin",
      action: decision,
      reason: reason.length > 0 ? reason : null,
      actor_wallet: wallet,
    });

    return NextResponse.json({ ok: true, data: { id, decision } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
