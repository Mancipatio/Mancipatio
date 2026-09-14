// POST /api/vesting/create — persist a vesting schedule + milestones +
// beneficiaries in one signed call (replaces the anon inserts the
// /admin/rights/builder page used to do directly).
//
// Authz: signed + requireAdmin — the builder is an admin-only surface.
// `author` and `status` are stamped SERVER-side (author = verified wallet;
// status derived from what was actually provided, mirroring the old client
// logic: merkle_root -> merkle_built, beneficiaries -> beneficiaries_set,
// else draft).
//
// Client wrapper: saveVestingSchedule() in lib/vesting.ts
// (action "vesting.create").

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import {
  BASE58_RE,
  DIGITS_RE,
  HEX64_RE,
  ISO_DATE_RE,
  isPlainObject,
} from "../_lib";

const CURVES = new Set(["cliff", "linear", "step", "custom"]);
const MAX_MILESTONES = 600;
const MAX_BENEFICIARIES = 5_000;
const MAX_PROOF_LEN = 40; // 2^40 leaves — far beyond any realistic tree.
const CHUNK = 500; // Supabase multi-row insert comfort zone.

function optInt(v: unknown, name: string, max: number): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > max) {
    throw new SiwsError(400, `${name} must be an integer 0–${max}`);
  }
  return v;
}

function optDate(v: unknown, name: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || !ISO_DATE_RE.test(v)) {
    throw new SiwsError(400, `${name} must be an ISO date (yyyy-mm-dd)`);
  }
  return v;
}

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "vesting.create");
    await requireAdmin(wallet);

    if (!isPlainObject(params.schedule)) {
      throw new SiwsError(400, "Missing schedule");
    }
    const s = params.schedule;

    // ---- schedule meta ----------------------------------------------------
    const assetMint =
      typeof s.asset_mint === "string" ? s.asset_mint.trim() : "";
    if (!BASE58_RE.test(assetMint)) {
      throw new SiwsError(400, "asset_mint must be a base58 address");
    }
    const title = typeof s.title === "string" ? s.title.trim() : "";
    if (!title || title.length > 120) {
      throw new SiwsError(400, "title required (≤120 chars)");
    }
    const assetLabel =
      typeof s.asset_label === "string" ? s.asset_label.trim() : "";
    if (assetLabel.length > 80) {
      throw new SiwsError(400, "asset_label too long (≤80 chars)");
    }
    const description =
      typeof s.description === "string" ? s.description : "";
    if (description.length > 2_000) {
      throw new SiwsError(400, "description too long (≤2000 chars)");
    }
    const curve = typeof s.curve === "string" ? s.curve : "";
    if (!CURVES.has(curve)) {
      throw new SiwsError(400, "Unknown curve");
    }
    const totalAmount =
      typeof s.total_amount === "string" ? s.total_amount : "";
    if (!DIGITS_RE.test(totalAmount)) {
      throw new SiwsError(400, "total_amount must be a digit string (≤36)");
    }
    const startDate = optDate(s.start_date, "start_date");
    const cliffDate = optDate(s.cliff_date, "cliff_date");
    const durationMonths = optInt(s.duration_months, "duration_months", 600);
    const stepCount = optInt(s.step_count, "step_count", 600);
    const stepIntervalMonths = optInt(
      s.step_interval_months,
      "step_interval_months",
      600,
    );
    let merkleRoot: string | null = null;
    if (s.merkle_root !== null && s.merkle_root !== undefined) {
      if (typeof s.merkle_root !== "string" || !HEX64_RE.test(s.merkle_root)) {
        throw new SiwsError(400, "merkle_root must be 64 hex chars");
      }
      merkleRoot = s.merkle_root;
    }

    // ---- milestones -------------------------------------------------------
    const rawMilestones = Array.isArray(params.milestones)
      ? params.milestones
      : [];
    if (rawMilestones.length > MAX_MILESTONES) {
      throw new SiwsError(400, `Too many milestones (≤${MAX_MILESTONES})`);
    }
    const seenIdx = new Set<number>();
    const milestones = rawMilestones.map((m) => {
      if (!isPlainObject(m)) throw new SiwsError(400, "Invalid milestone");
      const idx = m.idx;
      if (
        typeof idx !== "number" ||
        !Number.isInteger(idx) ||
        idx < 0 ||
        idx > MAX_MILESTONES
      ) {
        throw new SiwsError(400, "milestone idx must be a small integer");
      }
      if (seenIdx.has(idx)) {
        throw new SiwsError(400, `Duplicate milestone idx ${idx}`);
      }
      seenIdx.add(idx);
      if (
        typeof m.unlock_date !== "string" ||
        !ISO_DATE_RE.test(m.unlock_date)
      ) {
        throw new SiwsError(400, "milestone unlock_date must be yyyy-mm-dd");
      }
      if (typeof m.amount !== "string" || !DIGITS_RE.test(m.amount)) {
        throw new SiwsError(400, "milestone amount must be a digit string");
      }
      return {
        idx,
        unlock_date: m.unlock_date,
        amount: m.amount,
        published: false,
      };
    });

    // ---- beneficiaries ----------------------------------------------------
    const rawBens = Array.isArray(params.beneficiaries)
      ? params.beneficiaries
      : [];
    if (rawBens.length > MAX_BENEFICIARIES) {
      throw new SiwsError(
        400,
        `Too many beneficiaries (≤${MAX_BENEFICIARIES})`,
      );
    }
    const seenWallets = new Set<string>();
    const beneficiaries = rawBens.map((b) => {
      if (!isPlainObject(b)) throw new SiwsError(400, "Invalid beneficiary");
      const w = typeof b.wallet === "string" ? b.wallet.trim() : "";
      if (!BASE58_RE.test(w)) {
        throw new SiwsError(400, "beneficiary wallet must be base58");
      }
      if (seenWallets.has(w)) {
        throw new SiwsError(400, `Duplicate beneficiary wallet ${w}`);
      }
      seenWallets.add(w);
      if (typeof b.entitlement !== "string" || !DIGITS_RE.test(b.entitlement)) {
        throw new SiwsError(400, "entitlement must be a digit string");
      }
      const mi = b.merkle_index;
      if (
        typeof mi !== "number" ||
        !Number.isInteger(mi) ||
        mi < 0 ||
        mi >= MAX_BENEFICIARIES
      ) {
        throw new SiwsError(400, "merkle_index must be a small integer");
      }
      const proof = b.merkle_proof;
      if (
        !Array.isArray(proof) ||
        proof.length > MAX_PROOF_LEN ||
        !proof.every((p) => typeof p === "string" && HEX64_RE.test(p))
      ) {
        throw new SiwsError(400, "merkle_proof must be an array of hex-64");
      }
      return {
        wallet: w,
        entitlement: b.entitlement,
        merkle_index: mi,
        merkle_proof: proof,
      };
    });

    if (beneficiaries.length > 0 && merkleRoot === null) {
      throw new SiwsError(400, "merkle_root required when beneficiaries set");
    }

    // ---- writes (service role) -------------------------------------------
    const sb = getSupabaseAdmin();
    const status = merkleRoot
      ? "merkle_built"
      : beneficiaries.length > 0
        ? "beneficiaries_set"
        : "draft";

    const { data: row, error: insErr } = await sb
      .from("vesting_schedules")
      .insert({
        asset_mint: assetMint,
        asset_label: assetLabel || assetMint.slice(0, 8),
        title,
        description,
        curve,
        total_amount: totalAmount,
        start_date: startDate,
        duration_months: durationMonths,
        step_count: stepCount,
        step_interval_months: stepIntervalMonths,
        cliff_date: cliffDate,
        curve_config: {},
        merkle_root: merkleRoot,
        merkle_built_at: merkleRoot ? new Date().toISOString() : null,
        status,
        author: wallet, // server-stamped from the verified signature
      })
      .select("id")
      .single();
    if (insErr || !row) {
      console.error(
        "[api/vesting/create] schedule insert failed:",
        insErr?.message,
      );
      throw new SiwsError(500, "Schedule write failed");
    }
    const scheduleId = row.id as string;

    // Child inserts; on any failure, roll the whole schedule back (FK
    // cascade deletes children) so the client never sees a half-saved row.
    try {
      for (let i = 0; i < milestones.length; i += CHUNK) {
        const { error } = await sb.from("vesting_milestones").insert(
          milestones
            .slice(i, i + CHUNK)
            .map((m) => ({ ...m, schedule_id: scheduleId })),
        );
        if (error) throw new Error(error.message);
      }
      for (let i = 0; i < beneficiaries.length; i += CHUNK) {
        const { error } = await sb.from("vesting_beneficiaries").insert(
          beneficiaries
            .slice(i, i + CHUNK)
            .map((b) => ({ ...b, schedule_id: scheduleId })),
        );
        if (error) throw new Error(error.message);
      }
    } catch (childErr) {
      console.error(
        "[api/vesting/create] child insert failed — rolling back:",
        childErr instanceof Error ? childErr.message : childErr,
      );
      await sb.from("vesting_schedules").delete().eq("id", scheduleId);
      throw new SiwsError(500, "Schedule write failed");
    }

    return NextResponse.json({
      ok: true,
      data: {
        schedule_id: scheduleId,
        status,
        milestones: milestones.length,
        beneficiaries: beneficiaries.length,
      },
    });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
