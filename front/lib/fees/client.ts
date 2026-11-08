"use client";

// Browser side of the fee schedule (migration 0089).
//   fetchPublishedFees      — GET /api/fees/public (unsigned; the quote surfaces)
//   listFeeSchedule         — fees.scheduleList (session read; admin)
//   saveFeeDraft            — fees.scheduleSave (admin)
//   publishFeeDraft         — fees.schedulePublish (Super Admin)
//   retireFee               — fees.scheduleRetire (Super Admin)
//   deleteFeeDraft          — fees.scheduleDelete (admin)
//   loadSuggestedFeeDrafts  — fees.scheduleDefaults (admin)
//   createFeeCharge         — fees.chargeCreate (admin)
//   updateFeeCharge         — fees.chargeUpdate (admin)
// Every admin call THROWS with the server's message; every write signs afresh.

import type { WalletSession } from "@solana/client";
import { signedFetch } from "@/lib/siws-client";
import {
  orderPublicFees,
  parsePublicFee,
  type FeeChargeRow,
  type FeeDraftInput,
  type FeeKind,
  type FeeRefType,
  type FeeScheduleRow,
  type PublicFee,
} from "@/lib/fees/schedule";
import type { FeeQuote } from "@/lib/fees/quote";

type Session = WalletSession | null | undefined;

let published: Promise<PublicFee[]> | null = null;

/**
 * The published fees (display order). One request per page load is shared
 * by every quote surface on it; a failed read is forgotten so the next
 * mount retries. THROWS on failure — never an empty list, so a caller can
 * tell "no fee published" from "could not load".
 */
export function fetchPublishedFees(): Promise<PublicFee[]> {
  published ??= (async () => {
    // Older browsers lack AbortSignal.timeout; the read then simply has no deadline.
    const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(10_000) : undefined;
    const res = await fetch("/api/fees/public", { cache: "no-store", signal });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: { fees?: unknown } } | null;
    if (!res.ok || !json?.ok || !Array.isArray(json.data?.fees)) throw new Error("The published fees could not be loaded");
    const fees = json.data.fees.map(parsePublicFee);
    if (fees.some((fee) => fee === null)) throw new Error("The published fees could not be read");
    return orderPublicFees(fees as PublicFee[]);
  })().catch((error: unknown) => {
    published = null;
    throw error;
  });
  return published;
}

export async function listFeeSchedule(session: Session): Promise<{ schedule: FeeScheduleRow[]; charges: FeeChargeRow[] }> {
  const data = await signedFetch<{ schedule?: FeeScheduleRow[]; charges?: FeeChargeRow[] }>(
    session, "/api/fees/schedule-list", "fees.scheduleList", {},
  );
  return { schedule: data.schedule ?? [], charges: data.charges ?? [] };
}

/** Create a draft (no id, expected null) or edit one (its id and last updated_at). */
export async function saveFeeDraft(
  session: Session,
  fee: FeeDraftInput,
  existing: { id: string; updated_at: string } | null,
): Promise<FeeScheduleRow> {
  const data = await signedFetch<{ fee: FeeScheduleRow }>(session, "/api/fees/schedule-save", "fees.scheduleSave", {
    fee,
    ...(existing ? { id: existing.id } : {}),
    expected_updated_at: existing ? existing.updated_at : null,
  });
  return data.fee;
}

export async function publishFeeDraft(
  session: Session,
  row: { id: string; updated_at: string },
): Promise<{ fee: FeeScheduleRow; replaced: FeeScheduleRow | null }> {
  return signedFetch(session, "/api/fees/schedule-publish", "fees.schedulePublish", {
    id: row.id, expected_updated_at: row.updated_at,
  });
}

export async function retireFee(session: Session, row: { id: string; updated_at: string }): Promise<FeeScheduleRow> {
  const data = await signedFetch<{ fee: FeeScheduleRow }>(session, "/api/fees/schedule-retire", "fees.scheduleRetire", {
    id: row.id, expected_updated_at: row.updated_at,
  });
  return data.fee;
}

export async function deleteFeeDraft(session: Session, row: { id: string; updated_at: string }): Promise<void> {
  await signedFetch(session, "/api/fees/schedule-delete", "fees.scheduleDelete", {
    id: row.id, expected_updated_at: row.updated_at,
  });
}

export async function loadSuggestedFeeDrafts(session: Session): Promise<{ created: FeeScheduleRow[]; skipped: FeeKind[] }> {
  return signedFetch(session, "/api/fees/schedule-defaults", "fees.scheduleDefaults", {});
}

export type FeeChargeRequest = {
  kind: FeeKind;
  ref_type: FeeRefType;
  ref_id: string;
  base_amount_eur: string;
  quantity?: number;
  payer_client_id?: string | null;
  issuer_pda?: string | null;
  note?: string;
};

export async function createFeeCharge(session: Session, request: FeeChargeRequest): Promise<{ charge: FeeChargeRow; quote: FeeQuote }> {
  return signedFetch(session, "/api/fees/charge-create", "fees.chargeCreate", { ...request });
}

export type FeeChargeMove =
  | { status: "invoiced"; invoice_ref: string }
  | { status: "paid" }
  | { status: "waived"; waived_reason: string };

export async function updateFeeCharge(
  session: Session,
  row: { id: string; updated_at: string },
  move: FeeChargeMove,
): Promise<FeeChargeRow> {
  const data = await signedFetch<{ charge: FeeChargeRow }>(session, "/api/fees/charge-update", "fees.chargeUpdate", {
    id: row.id, expected_updated_at: row.updated_at, ...move,
  });
  return data.charge;
}
