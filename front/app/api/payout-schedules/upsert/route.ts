// POST /api/payout-schedules/upsert — create or edit one payout_schedules row.
// Signed (SIWS) + on-chain admin gate. On insert, created_by is stamped with
// the VERIFIED signer (never client-supplied); on update it is left untouched.
// "Mark done" on /admin/payouts also lands here — the client advances
// next_due by one cadence period and sends the row back with its id.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";

const CADENCES = new Set(["monthly", "quarterly", "annual"]);
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Optional base58 field: returns trimmed value, null (cleared) or throws. */
function optionalBase58(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new SiwsError(400, `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!BASE58_RE.test(trimmed)) {
    throw new SiwsError(400, `${field} must be a base58 Solana address`);
  }
  return trimmed;
}

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(
      request,
      "payoutSchedules.upsert",
    );
    await requireAdmin(wallet);

    const id = params.id === undefined || params.id === null ? null : params.id;
    if (id !== null && (typeof id !== "string" || !UUID_RE.test(id))) {
      throw new SiwsError(400, "id must be a UUID");
    }

    const shareClassPda =
      typeof params.share_class_pda === "string"
        ? params.share_class_pda.trim()
        : "";
    if (!BASE58_RE.test(shareClassPda)) {
      throw new SiwsError(400, "share_class_pda must be a base58 address");
    }

    const mint = optionalBase58(params.mint, "mint");
    const paymentMint = optionalBase58(params.payment_mint, "payment_mint");

    const label = typeof params.label === "string" ? params.label.trim() : "";
    if (label.length > 120) {
      throw new SiwsError(400, "label must be at most 120 characters");
    }

    const cadence = typeof params.cadence === "string" ? params.cadence : "";
    if (!CADENCES.has(cadence)) {
      throw new SiwsError(400, "cadence must be monthly, quarterly or annual");
    }

    const nextDue =
      typeof params.next_due === "string" ? params.next_due.trim() : "";
    if (!DATE_RE.test(nextDue) || Number.isNaN(Date.parse(`${nextDue}T00:00:00Z`))) {
      throw new SiwsError(400, "next_due must be a valid YYYY-MM-DD date");
    }

    let amountHint: number | null = null;
    if (params.amount_hint !== undefined && params.amount_hint !== null) {
      const n = params.amount_hint;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
        throw new SiwsError(400, "amount_hint must be a non-negative number");
      }
      amountHint = n;
    }

    if (typeof params.active !== "boolean") {
      throw new SiwsError(400, "active must be a boolean");
    }

    const notes = typeof params.notes === "string" ? params.notes.trim() : "";
    if (notes.length > 2000) {
      throw new SiwsError(400, "notes must be at most 2000 characters");
    }

    const row = {
      share_class_pda: shareClassPda,
      mint,
      label: label || null,
      cadence,
      next_due: nextDue,
      amount_hint: amountHint,
      payment_mint: paymentMint,
      active: params.active,
      notes: notes || null,
    };

    const sb = getSupabaseAdmin();
    if (id === null) {
      const { data, error } = await sb
        .from("payout_schedules")
        .insert({ ...row, created_by: wallet })
        .select("id")
        .single();
      if (error || !data) {
        console.error(
          "[api/payout-schedules/upsert] insert failed:",
          error?.message,
        );
        throw new SiwsError(500, "Could not save the schedule");
      }
      return NextResponse.json({ ok: true, data: { id: data.id as string } });
    }

    // Update path — created_by stays as originally stamped.
    const { data, error } = await sb
      .from("payout_schedules")
      .update(row)
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (error) {
      console.error(
        "[api/payout-schedules/upsert] update failed:",
        error.message,
      );
      throw new SiwsError(500, "Could not save the schedule");
    }
    if (!data) throw new SiwsError(404, "Schedule not found");

    return NextResponse.json({ ok: true, data: { id } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
