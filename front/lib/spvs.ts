"use client";

import type { WalletSession } from "@solana/client";
import { getSupabase } from "@/lib/supabase";
import { detectNetwork } from "@/lib/network";
import { signedFetch } from "@/lib/siws-client";

export type SpvStatus = "planned" | "incorporating" | "active" | "retired";

export type SpvRow = {
  id: string;
  created_at: string;
  updated_at: string;
  network: string;
  name: string;
  registration_number: string | null;
  country: string;
  status: SpvStatus;
  client_id: string | null;
  issuer_pda: string | null;
  incorporated_at: string | null;
  annual_cap_eur: number;
  notes: string;
};

export type SpvIssuance = {
  id: number;
  created_at: string;
  spv_id: string;
  asset_pda: string | null;
  sale_pubkey: string | null;
  amount_eur: number;
  issued_at: string;
  note: string | null;
  recorded_by: string | null;
  /** 'manual' (an off-chain adjustment), 'sale' (booked by the server when a
   *  sale closes) or 'treasury_mint' (booked from a finalized treasury mint). */
  source?: string;
  /** True when the row was recorded past the cap via super-admin override. */
  cap_override?: boolean;
  /** Manual adjustments since 0073: why the chain does not show it. */
  reason_code?: AdjustmentReason | null;
};

export type AdjustmentReason = "off_platform_issuance" | "correction" | "legacy_import";
export const ADJUSTMENT_REASONS: readonly { value: AdjustmentReason; label: string }[] = [
  { value: "off_platform_issuance", label: "Off-platform issuance" },
  { value: "correction", label: "Correction" },
  { value: "legacy_import", label: "Legacy import" },
];

/** Rolling 12-month capacity of an SPV or of an asset's subject (POST /api/spvs/capacity). */
export type SpvCapacity = {
  subject: string;
  spv_id: string | null;
  cap: number;
  issued: number;
  reserved: number;
  used: number;
  remaining: number;
  window_start: string;
  cap_source: string;
  holds: number;
};

export type SpvCreateInput = {
  name: string;
  registration_number?: string;
  country?: string;
  status?: SpvStatus;
  client_id?: string;
  issuer_pda?: string;
  incorporated_at?: string;
  notes?: string;
};

export async function listSpvs(): Promise<SpvRow[]> {
  const sb = getSupabase();
  if (!sb) return [];
  const { data, error } = await sb
    .from("spvs")
    .select("*")
    .eq("network", detectNetwork())
    .order("created_at", { ascending: false });
  if (error) {
    console.warn("[spvs] list failed:", error.message);
    return [];
  }
  return (data ?? []) as SpvRow[];
}

export async function getSpv(id: string): Promise<SpvRow | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb.from("spvs").select("*").eq("id", id).maybeSingle();
  if (error || !data) return null;
  return data as SpvRow;
}

/** Create an SPV via the signed admin route (POST /api/spvs/create). */
export async function createSpv(
  session: WalletSession | null | undefined,
  input: SpvCreateInput,
): Promise<string | null> {
  try {
    const data = await signedFetch<{ id: string }>(
      session,
      "/api/spvs/create",
      "spvs.create",
      {
        name: input.name,
        registration_number: input.registration_number,
        country: input.country ?? "688",
        status: input.status ?? "planned",
        client_id: input.client_id,
        issuer_pda: input.issuer_pda,
        incorporated_at: input.incorporated_at,
        notes: input.notes ?? "",
      },
    );
    return data.id;
  } catch (err) {
    console.warn(
      "[spvs] create failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** Patch an SPV via the signed admin route (POST /api/spvs/update). */
export async function updateSpv(
  session: WalletSession | null | undefined,
  id: string,
  patch: Partial<
    Pick<
      SpvRow,
      | "name"
      | "registration_number"
      | "country"
      | "status"
      | "client_id"
      | "issuer_pda"
      | "incorporated_at"
      | "notes"
    >
  >,
): Promise<boolean> {
  try {
    await signedFetch(session, "/api/spvs/update", "spvs.update", {
      id,
      patch,
    });
    return true;
  } catch (err) {
    console.warn(
      "[spvs] update failed:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/** The SPV's issuance ledger through the signed admin route (anonymous reads end with 0074). Null when it could not be read. */
export async function listIssuances(
  session: WalletSession | null | undefined,
  spvId: string,
): Promise<SpvIssuance[] | null> {
  try {
    return await signedFetch<SpvIssuance[]>(session, "/api/spvs/issuances", "spvs.issuances", { spv_id: spvId });
  } catch (err) {
    console.warn("[spvs] issuances failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Rolling 12-month capacity: an SPV (admin) or the subject behind an asset (admin or its issuer). Null when unavailable. */
export async function spvCapacity(
  session: WalletSession | null | undefined,
  target: { spv_id: string } | { asset: string },
): Promise<SpvCapacity | null> {
  try {
    const data = await signedFetch<SpvCapacity>(session, "/api/spvs/capacity", "spvs.capacity", target);
    const num = (v: unknown) => Number(v ?? 0);
    return { ...data, cap: num(data.cap), issued: num(data.issued), reserved: num(data.reserved), used: num(data.used),
      remaining: num(data.remaining), holds: num(data.holds) };
  } catch (err) {
    console.warn("[spvs] capacity failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** An off-chain adjustment (Talas 5.1): on-chain sales and mints are booked by the server. */
export type SpvIssuanceInput = {
  spv_id: string;
  amount_eur: number;
  /** An asset PDA (never a sale). */
  asset_pda?: string;
  issued_at?: string;
  reason_code: AdjustmentReason;
  /** At least 10 characters. */
  note: string;
  /** After a POSSIBLE_DUPLICATE answer: the admin confirmed it is another issuance. */
  confirm_not_duplicate?: boolean;
  /** Super-admin cap bypass — server-enforced via requireSuperAdmin. Only send when true. */
  cap_override?: boolean;
};

export type RecordIssuanceResult = { ok: boolean; error?: string; possibleDuplicate?: boolean };

/**
 * Book an issuance via the signed admin route
 * (POST /api/spvs/record-issuance). cap_override escalates to the super-admin
 * gate server-side; the 0027 DB trigger stays the authoritative cap guard.
 */
export async function recordIssuance(
  session: WalletSession | null | undefined,
  input: SpvIssuanceInput,
): Promise<RecordIssuanceResult> {
  try {
    await signedFetch(
      session,
      "/api/spvs/record-issuance",
      "spvs.record_issuance",
      {
        spv_id: input.spv_id,
        amount_eur: input.amount_eur,
        asset_pda: input.asset_pda,
        issued_at: input.issued_at,
        reason_code: input.reason_code,
        note: input.note,
        ...(input.confirm_not_duplicate ? { confirm_not_duplicate: true } : {}),
        ...(input.cap_override ? { cap_override: true } : {}),
      },
    );
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[spvs] record issuance failed:", msg);
    return { ok: false, error: msg, possibleDuplicate: /^Possible duplicate/.test(msg) };
  }
}
