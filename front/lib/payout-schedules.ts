"use client";

// Recurring payout schedules (table: payout_schedules, migration 0033).
//
// Planning registry only — rows never move funds. Admins manage schedules on
// /admin/payouts (due panel + CRUD modal); issuers get a read-only "Upcoming
// payouts" card on /issuer/payouts.
//
// Access matrix:
//   reads  — anon SELECT (client-side; no PII, but that means EVERY column —
//            notes and amount_hint included — is world-readable; the UI
//            labels notes as public and confidential terms belong in the
//            fee register)
//   writes — signed routes only (SIWS + on-chain admin gate):
//     payoutSchedules.upsert — /api/payout-schedules/upsert (created_by is
//                              stamped with the VERIFIED signer server-side)
//     payoutSchedules.delete — /api/payout-schedules/delete
//
// FOLLOW-UP (not built): no keeper/cron auto-advances next_due or sends
// reminders — "due" is computed at read time (see scheduleDueStatus). If
// automation is ever wanted, add a scheduled job over (active, next_due).

import type { WalletSession } from "@solana/client";
import { signedFetch } from "@/lib/siws-client";
import { getSupabase } from "@/lib/supabase";

export type PayoutCadence = "monthly" | "quarterly" | "annual";

export type PayoutSchedule = {
  id: string;
  share_class_pda: string;
  mint: string | null;
  label: string | null;
  cadence: PayoutCadence;
  /** ISO date (YYYY-MM-DD). */
  next_due: string;
  amount_hint: number | null;
  payment_mint: string | null;
  active: boolean;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const CADENCES: PayoutCadence[] = ["monthly", "quarterly", "annual"];

export const CADENCE_LABEL: Record<PayoutCadence, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  annual: "Annual",
};

const CADENCE_MONTHS: Record<PayoutCadence, number> = {
  monthly: 1,
  quarterly: 3,
  annual: 12,
};

/** All schedules, soonest next_due first (active ones sort before inactive). */
export async function listPayoutSchedules(): Promise<PayoutSchedule[]> {
  const sb = getSupabase();
  if (!sb) throw new Error("Supabase is not configured");
  const { data, error } = await sb
    .from("payout_schedules")
    .select("*")
    .order("active", { ascending: false })
    .order("next_due", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as PayoutSchedule[];
}

export type PayoutScheduleInput = {
  /** Present = update that row; absent = insert. */
  id?: string;
  share_class_pda: string;
  mint?: string | null;
  label?: string | null;
  cadence: PayoutCadence;
  next_due: string;
  amount_hint?: number | null;
  payment_mint?: string | null;
  active: boolean;
  notes?: string | null;
};

/** Create or edit one schedule (admin only — signed route). Returns the id. */
export async function upsertPayoutSchedule(
  session: WalletSession | null | undefined,
  input: PayoutScheduleInput,
): Promise<string> {
  const data = await signedFetch<{ id: string }>(
    session,
    "/api/payout-schedules/upsert",
    "payoutSchedules.upsert",
    { ...input },
  );
  return data.id;
}

/** Remove one schedule (admin only — signed route). */
export async function deletePayoutSchedule(
  session: WalletSession | null | undefined,
  id: string,
): Promise<void> {
  await signedFetch(
    session,
    "/api/payout-schedules/delete",
    "payoutSchedules.delete",
    { id },
  );
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Advance an ISO date (YYYY-MM-DD) by one cadence period, clamping to the
 * last day of the target month (Jan 31 + monthly -> Feb 28/29). UTC math —
 * no timezone drift.
 */
export function advanceCadence(isoDate: string, cadence: PayoutCadence): string {
  if (!DATE_RE.test(isoDate)) throw new Error(`Invalid date: ${isoDate}`);
  const [y, m, d] = isoDate.split("-").map(Number);
  const months = CADENCE_MONTHS[cadence];
  const targetMonthIndex = m - 1 + months; // 0-based month arithmetic
  // Day 0 of month N+1 = last day of month N.
  const lastDay = new Date(
    Date.UTC(y, targetMonthIndex + 1, 0),
  ).getUTCDate();
  const next = new Date(Date.UTC(y, targetMonthIndex, Math.min(d, lastDay)));
  return next.toISOString().slice(0, 10);
}

/** Today's date as ISO YYYY-MM-DD (UTC). */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export type ScheduleDueStatus = "overdue" | "due_soon" | "upcoming";

/** How many days from `fromIso` until `toIso` (negative = past). */
export function daysUntil(toIso: string, fromIso: string = todayIso()): number {
  const to = Date.parse(`${toIso}T00:00:00Z`);
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

/**
 * Due classification used by the admin panel: overdue (next_due strictly in
 * the past), due_soon (within the next 14 days, today inclusive), upcoming.
 */
export function scheduleDueStatus(
  nextDue: string,
  fromIso: string = todayIso(),
): ScheduleDueStatus {
  const days = daysUntil(nextDue, fromIso);
  if (days < 0) return "overdue";
  if (days <= 14) return "due_soon";
  return "upcoming";
}
