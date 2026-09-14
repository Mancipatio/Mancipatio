"use client";

import type { WalletSession } from "@solana/client";
import type { PublicAssetProfile } from "@/lib/profile-public";
export type { PublicAssetProfile } from "@/lib/profile-public";
import { signedFetch } from "@/lib/siws-client";
import type { CategorySlug, FieldDef } from "@/lib/asset-types";

/** Off-chain per-category product metadata for an on-chain Asset.
 *  Keyed by the asset PDA (= public.assets.pda). See migration 0014. */
export type AssetProfile = {
  asset_pda: string;
  network: string;
  issuer_pda: string | null;
  category: CategorySlug;

  // common
  display_name: string | null;
  summary: string | null;
  description: string | null;
  cover_image_path: string | null;
  logo_letter: string | null;
  logo_gradient: string | null;
  website: string | null;
  legal_doc_path: string | null;
  legal_doc_sha256: string | null;
  jurisdiction: string | null;
  tags: string[];
  status: "draft" | "published" | "archived";
  is_published: boolean;

  // SPV linkage (migration 0018) + whitepaper / basic token information (0019)
  spv_id: string | null;
  whitepaper_path: string | null;
  whitepaper_sha256: string | null;
  whitepaper_version_id?: string | null;
  whitepaper_url: string | null;
  whitepaper_status:
    | "none"
    | "draft"
    | "published"
    | "ssc_approval_pending"
    | "ssc_approved";
  whitepaper_published_at: string | null;

  // SSC approval evidence (migration 0026) — the ssc_approved status must be
  // backed by a decision reference; the decision document is optional.
  ssc_decision_ref: string | null;
  ssc_decision_doc_path: string | null;
  ssc_decision_doc_sha256: string | null;
  ssc_decision_version_id?: string | null;

  // category-specific (all optional — only the active category's columns are set)
  pre_money_valuation: number | null;
  share_price: number | null;
  total_shares: number | null;
  liquidation_pref_bps: number | null;
  has_voting: boolean | null;
  dividend_policy: string | null;
  convertible: boolean | null;
  cap_table_doc_path: string | null;
  round_series: string | null;

  revenue_pct_bps: number | null;
  revenue_basis: "gross" | "net" | null;
  cap_multiple: number | null;
  trigger_threshold: number | null;
  measurement_period: string | null;
  reporting_cadence: string | null;

  royalty_rate_bps: number | null;
  underlying_contract: string | null;
  ip_description: string | null;
  revenue_source: string | null;
  payment_frequency: string | null;
  termination_date: string | null;
  territory: string | null;
  historical_revenue: string | null;

  spv_reference: string | null;
  address: string | null;
  square_meters: number | null;
  valuation: number | null;
  appraisal_date: string | null;
  income_share_bps: number | null;
  occupancy_pct: number | null;
  property_doc_path: string | null;
  kyb_gated: boolean | null;

  principal: number | null;
  coupon_rate_bps: number | null;
  coupon_frequency: string | null;
  maturity_date: string | null;
  seniority: string | null;
  default_trigger: string | null;
  collateral_desc: string | null;

  underlying: string | null;
  unit: string | null;
  quantity: number | null;
  storage_provider: string | null;
  storage_location: string | null;
  storage_proof_ref: string | null;
  settlement_window: string | null;
  assay_doc_path: string | null;

  item_description: string | null;
  custodian: string | null;
  custody_location: string | null;
  insurance_policy_ref: string | null;
  insurance_coverage: string | null;
  appraised_value: number | null;
  inspection_cadence: string | null;
  condition_report_path: string | null;

  custom_metadata_uri: string | null;
  schema_label: string | null;
  fields: Record<string, unknown>;

  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type NewAssetProfile = Partial<AssetProfile> & {
  asset_pda: string;
  category: CategorySlug;
};

/** Public reads expose only published, explicitly allowlisted product fields. */
export async function listAssetProfiles(opts?: {
  category?: CategorySlug;
  publishedOnly?: boolean;
  pdas?: string[];
  signal?: AbortSignal;
}): Promise<PublicAssetProfile[]> {
  if (opts?.pdas?.length === 0) return [];
  const rows: PublicAssetProfile[] = [];
  const batches = opts?.pdas
    ? Array.from({ length: Math.ceil(opts.pdas.length / 100) }, (_, i) => opts.pdas!.slice(i * 100, i * 100 + 100))
    : [undefined];
  for (const pdas of batches) {
    for (let offset = 0; ; offset += 100) {
      const response = await fetch("/api/profiles/public", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: opts?.category, pdas, offset }),
        signal: opts?.signal, cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error ?? "Published profiles unavailable");
      const page = body.data as PublicAssetProfile[];
      rows.push(...page);
      if (page.length < 100 || pdas) break;
    }
  }
  return rows;
}

export async function getAssetProfile(assetPda: string): Promise<PublicAssetProfile | null> {
  return (await listAssetProfiles({ pdas: [assetPda] }))[0] ?? null;
}

export async function getAssetProfiles(assetPdas: string[]): Promise<Map<string, PublicAssetProfile>> {
  return new Map((await listAssetProfiles({ pdas: assetPdas })).map((row) => [row.asset_pda, row]));
}

/** Draft/full rows require an admin or each asset's on-chain issuer signature. */
export async function getPrivateAssetProfiles(
  session: WalletSession | null | undefined,
  assetPdas: string[],
): Promise<Map<string, AssetProfile>> {
  const rows: AssetProfile[] = [];
  for (let offset = 0; offset < assetPdas.length; offset += 100) {
    rows.push(...await signedFetch<AssetProfile[]>(session, "/api/profiles/read", "profiles.read", {
      pdas: assetPdas.slice(offset, offset + 100),
    }));
  }
  return new Map(rows.map((row) => [row.asset_pda, row]));
}

export async function getPrivateAssetProfile(
  session: WalletSession | null | undefined, assetPda: string,
): Promise<AssetProfile | null> {
  return (await getPrivateAssetProfiles(session, [assetPda])).get(assetPda) ?? null;
}

/**
 * Create/update/publish an asset profile via the signed route
 * POST /api/profiles/upsert (W2-SD4).
 *
 * The connected WalletSession (useWalletConnection().wallet) is the FIRST
 * param — the server authorizes the write as either a platform admin or the
 * asset's on-chain Issuer.authority; SSC approval fields are admin-only and
 * `network` is stamped server-side. Returns false (with a console warning)
 * on any failure — same graceful contract as before.
 */
export async function upsertAssetProfile(
  session: WalletSession | null | undefined,
  profile: NewAssetProfile,
): Promise<boolean> {
  try {
    await signedFetch(session, "/api/profiles/upsert", "profiles.upsert", {
      profile,
    });
    return true;
  } catch (e) {
    console.warn(
      "[asset-profiles] upsertAssetProfile failed:",
      e instanceof Error ? e.message : e,
    );
    return false;
  }
}

/** Convert a raw form input value into the column value per the field's type.
 *  bps: percent → int basis points; mult: multiple → int (×10000). */
export function toColumnValue(
  field: FieldDef,
  raw: string | boolean,
): string | number | boolean | null {
  if (field.type === "boolean") return Boolean(raw);
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s === "" && typeof raw === "string") return null;
  switch (field.type) {
    case "number": {
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    }
    case "bps": {
      const n = Number(s);
      return Number.isFinite(n) ? Math.round(n * 100) : null;
    }
    case "mult": {
      const n = Number(s);
      return Number.isFinite(n) ? Math.round(n * 10000) : null;
    }
    default:
      return s;
  }
}

/** Inverse of toColumnValue, for prefilling an edit form from a stored value. */
export function toFormValue(
  field: FieldDef,
  stored: unknown,
): string | boolean {
  if (field.type === "boolean") return Boolean(stored);
  if (stored === null || stored === undefined) return "";
  if (field.type === "bps" && typeof stored === "number")
    return String(stored / 100);
  if (field.type === "mult" && typeof stored === "number")
    return String(stored / 10000);
  return String(stored);
}

/** Human-readable display of a stored category value (for detail/fact panels). */
export function displayFieldValue(field: FieldDef, stored: unknown): string {
  if (stored === null || stored === undefined || stored === "") return "—";
  if (field.type === "boolean") return stored ? "Yes" : "No";
  if (field.type === "bps" && typeof stored === "number")
    return `${stored / 100}%`;
  if (field.type === "mult" && typeof stored === "number")
    return `${stored / 10000}×`;
  if (field.type === "number" && typeof stored === "number")
    return stored.toLocaleString("en-US");
  return String(stored);
}
