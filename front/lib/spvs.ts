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
  /** 'manual' (admin registry) or 'sale' (auto-booked after close_sale). Absent on pre-0027 rows. */
  source?: string;
  /** True when the row was recorded past the annual cap via super-admin override. Absent on pre-0027 rows. */
  cap_override?: boolean;
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

/** Legal ceiling per the Flows & Fact Sheets doc: EUR 3M issued per SPV per calendar year. */
export const SPV_ANNUAL_CAP_EUR = 3_000_000;

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

export async function listIssuances(spvId: string): Promise<SpvIssuance[]> {
  const sb = getSupabase();
  if (!sb) return [];
  const { data, error } = await sb
    .from("spv_issuances")
    .select("*")
    .eq("spv_id", spvId)
    .order("issued_at", { ascending: false });
  if (error) {
    console.warn("[spvs] issuances failed:", error.message);
    return [];
  }
  return (data ?? []) as SpvIssuance[];
}

export type SpvIssuanceInput = {
  spv_id: string;
  amount_eur: number;
  asset_pda?: string;
  sale_pubkey?: string;
  issued_at?: string;
  note?: string;
  /** IGNORED by the server — recorded_by is stamped with the verified signer wallet. */
  recorded_by?: string;
  /** Defaults to 'manual' at the DB level (migration 0027); pass 'sale' for auto-booked sale proceeds. */
  source?: string;
  /** Super-admin cap bypass — server-enforced via requireSuperAdmin. Only send when true. */
  cap_override?: boolean;
};

export type RecordIssuanceResult = { ok: boolean; error?: string };

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
        sale_pubkey: input.sale_pubkey,
        issued_at: input.issued_at,
        note: input.note,
        source: input.source,
        ...(input.cap_override ? { cap_override: true } : {}),
      },
    );
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[spvs] record issuance failed:", msg);
    return { ok: false, error: msg };
  }
}

/**
 * Auto-book sale proceeds against an SPV's annual EUR cap (source = 'sale').
 * Called by the launchpad after a successful close_sale when the asset profile
 * has a linked spv_id. Requires migration 0027 (source column + cap trigger);
 * the DB trigger rejects the insert if it would push the SPV over its
 * calendar-year cap (returns false with the trigger's message logged).
 */
export async function recordSaleIssuance(
  session: WalletSession | null | undefined,
  input: {
    spvId: string;
    amountEur: number;
    assetPda: string;
    note?: string;
  },
): Promise<boolean> {
  const res = await recordIssuance(session, {
    spv_id: input.spvId,
    amount_eur: input.amountEur,
    asset_pda: input.assetPda,
    note: input.note,
    source: "sale",
  });
  return res.ok;
}

/** Sum of issuances (EUR) booked against an SPV within one calendar year. */
export async function yearIssuanceTotal(spvId: string, year: number): Promise<number> {
  const sb = getSupabase();
  if (!sb) return 0;
  const { data, error } = await sb
    .from("spv_issuances")
    .select("amount_eur")
    .eq("spv_id", spvId)
    .gte("issued_at", `${year}-01-01`)
    .lt("issued_at", `${year + 1}-01-01`);
  if (error) {
    console.warn("[spvs] year total failed:", error.message);
    return 0;
  }
  return (data ?? []).reduce((sum, r) => sum + Number(r.amount_eur ?? 0), 0);
}
