// POST /api/vesting/publish-milestone — mark one milestone of a vesting
// schedule as published on-chain (off-chain bookkeeping flag).
//
// Authz: signed + requireVestingEditor — platform admin OR schedule author
// OR the on-chain Issuer.authority of the schedule's asset (see
// app/api/vesting/_lib.ts). Server-enforced replacement for the old anon
// UPDATE the /issuer/vesting/[id] page did directly.
//
// Client wrapper: markVestingMilestonePublished() in lib/vesting.ts
// (action "vesting.publish-milestone").

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { requireVestingEditor } from "../_lib";

const MAX_TX_LEN = 120; // base58 signature is 87–88 chars; generous cap.

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(
      request,
      "vesting.publish-milestone",
    );

    const scheduleId =
      typeof params.schedule_id === "string" ? params.schedule_id : "";
    const idx = params.idx;
    if (
      typeof idx !== "number" ||
      !Number.isInteger(idx) ||
      idx < 0 ||
      idx > 10_000
    ) {
      throw new SiwsError(400, "idx must be a small integer");
    }
    let publishedTx: string | null = null;
    if (params.published_tx !== undefined && params.published_tx !== null) {
      if (
        typeof params.published_tx !== "string" ||
        params.published_tx.length === 0 ||
        params.published_tx.length > MAX_TX_LEN
      ) {
        throw new SiwsError(400, "published_tx must be a short string");
      }
      publishedTx = params.published_tx;
    }

    const schedule = await requireVestingEditor(wallet, scheduleId);

    const sb = getSupabaseAdmin();
    const patch: Record<string, unknown> = {
      published: true,
      published_at: new Date().toISOString(),
    };
    if (publishedTx !== null) patch.published_tx = publishedTx;

    const { data, error } = await sb
      .from("vesting_milestones")
      .update(patch)
      .eq("schedule_id", schedule.id)
      .eq("idx", idx)
      .select("idx");
    if (error) {
      console.error(
        "[api/vesting/publish-milestone] update failed:",
        error.message,
      );
      throw new SiwsError(500, "Milestone update failed");
    }
    if (!data || data.length === 0) {
      throw new SiwsError(404, "Milestone not found");
    }

    return NextResponse.json({
      ok: true,
      data: { schedule_id: schedule.id, idx },
    });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
