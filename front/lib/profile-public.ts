import type { AssetProfile } from "@/lib/asset-profiles";

// Deliberately excludes arbitrary fields JSON, internal bookkeeping, draft
// document paths, private contracts, storage/custody locations and contact data.
export const PUBLIC_ASSET_PROFILE_FIELDS = [
  "asset_pda", "network", "issuer_pda", "category", "display_name", "summary",
  "description", "cover_image_path", "logo_letter", "logo_gradient", "website",
  "jurisdiction", "tags", "status", "is_published", "updated_at",
  "pre_money_valuation", "share_price", "total_shares", "liquidation_pref_bps",
  "has_voting", "dividend_policy", "convertible", "round_series",
  "revenue_pct_bps", "revenue_basis", "cap_multiple", "trigger_threshold",
  "measurement_period", "reporting_cadence", "royalty_rate_bps", "ip_description",
  "revenue_source", "payment_frequency", "termination_date", "territory",
  "square_meters", "valuation", "appraisal_date", "income_share_bps", "occupancy_pct",
  "principal", "coupon_rate_bps", "coupon_frequency", "maturity_date", "seniority",
  "default_trigger", "collateral_desc", "underlying", "unit", "quantity",
  "settlement_window", "item_description", "insurance_coverage", "appraised_value",
  "inspection_cadence", "schema_label", "whitepaper_path", "whitepaper_url",
  "whitepaper_sha256", "whitepaper_status", "whitepaper_published_at", "whitepaper_version_id",
  "ssc_decision_ref", "ssc_decision_doc_path", "ssc_decision_doc_sha256", "ssc_decision_version_id",
] as const satisfies readonly (keyof AssetProfile)[];

export type PublicAssetProfile = Pick<AssetProfile, (typeof PUBLIC_ASSET_PROFILE_FIELDS)[number]> & { spv_name: string | null };

const DOCUMENT_FIELDS = ["whitepaper_path", "whitepaper_url", "whitepaper_sha256", "whitepaper_version_id", "ssc_decision_version_id",
  "whitepaper_published_at", "ssc_decision_ref", "ssc_decision_doc_path",
  "ssc_decision_doc_sha256"] as const;

/** Re-project even after the DB SELECT so a later query change cannot leak keys. */
export function projectPublicAssetProfile(row: Record<string, unknown>): PublicAssetProfile | null {
  if (row.is_published !== true || row.status !== "published") return null;
  const out = Object.fromEntries(PUBLIC_ASSET_PROFILE_FIELDS.map((key) => [key, row[key] ?? null]));
  const publishedDocument = row.whitepaper_status === "published" || row.whitepaper_status === "ssc_approved";
  if (!publishedDocument) {
    for (const key of DOCUMENT_FIELDS) out[key] = null;
    out.whitepaper_status = "none";
  } else {
    // Only these asset-scoped paths belong in the public documents bucket.
    for (const key of ["whitepaper_path", "ssc_decision_doc_path"] as const) {
      const path = out[key];
      if (typeof path !== "string" || !path.startsWith(`whitepapers/${row.asset_pda}/`) ||
          path.split("/").some((part) => !part || part === "." || part === "..")) out[key] = null;
    }
    if (row.whitepaper_status !== "ssc_approved") {
      out.ssc_decision_ref = null;
      out.ssc_decision_doc_path = null;
      out.ssc_decision_doc_sha256 = null;
      out.ssc_decision_version_id = null;
    }
  }
  out.spv_name = null;
  return out as PublicAssetProfile;
}
