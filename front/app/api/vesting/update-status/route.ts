// POST /api/vesting/update-status — flip a vesting schedule's off-chain
// status (published / live / completed / cancelled …).
//
// Authz: signed + requireVestingEditor — platform admin OR schedule author
// OR the on-chain Issuer.authority of the schedule's asset (see
// app/api/vesting/_lib.ts). Server-enforced replacement for the old anon
// UPDATE the /issuer/vesting/[id] page did directly.
//
// Client wrapper: updateVestingScheduleStatus() in lib/vesting.ts
// (action "vesting.update-status").
//
// KYC-only mode (lib/features.ts kycOnly): moving a schedule forward
// (published, live, ...) is an issuance entry for an author or issuer, 403;
// completing or cancelling it stays open, and so does every admin.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { scopeEnabled } from "@/lib/features";
import { requireArea } from "@/lib/server/feature-gate";
import { isAdminWallet, requireVestingEditor, VESTING_STATUSES } from "../_lib";

/** The statuses that wind a schedule down: exits, open in KYC-only mode. */
const VESTING_EXIT_STATUSES = new Set(["completed", "cancelled"]);

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(
      request,
      "vesting.update-status",
    );

    const scheduleId =
      typeof params.schedule_id === "string" ? params.schedule_id : "";
    const status = typeof params.status === "string" ? params.status : "";
    if (!VESTING_STATUSES.has(status)) {
      throw new SiwsError(400, "Unknown vesting status");
    }
    // KYC-only mode (lib/features.ts): a non-admin's forward move is an issuance entry.
    if (!VESTING_EXIT_STATUSES.has(status) && !scopeEnabled("issuance") && !(await isAdminWallet(wallet))) {
      requireArea("issuance");
    }

    const schedule = await requireVestingEditor(wallet, scheduleId);

    const sb = getSupabaseAdmin();
    const { error } = await sb
      .from("vesting_schedules")
      .update({ status })
      .eq("id", schedule.id);
    if (error) {
      console.error(
        "[api/vesting/update-status] update failed:",
        error.message,
      );
      throw new SiwsError(500, "Status update failed");
    }

    return NextResponse.json({
      ok: true,
      data: { schedule_id: schedule.id, previous: schedule.status, status },
    });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
