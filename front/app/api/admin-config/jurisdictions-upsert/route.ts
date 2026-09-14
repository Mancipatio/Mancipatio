// POST /api/admin-config/jurisdictions-upsert — insert a new jurisdiction or
// partially update an existing one (edit modal + the sale/OTC/claim toggles).
//
// Signed (SIWS) + on-chain admin gate. Server-side invariants:
//   - insert derives enabled_sale/otc/claim from risk_tier (prohibited =>
//     everything disabled), same as the UI did;
//   - a jurisdiction whose EFFECTIVE risk_tier is 'prohibited' can never end
//     up with an enabled flag set to true — flags are forced false, so the
//     UI-side "toggles disabled when prohibited" rule is actually enforced.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";

const KYC_LEVELS = new Set(["none", "basic", "enhanced", "kyb"]);
const RISK_TIERS = new Set(["low", "medium", "high", "prohibited"]);
const CODE_RE = /^\d{1,4}$/; // ISO-3166 numeric, stored as text
const ALPHA2_RE = /^[A-Z]{2}$/;
const SLUG_RE = /^[a-z0-9_-]{1,40}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Narrow row.allowed_asset_types into a validated string array. */
function parseAssetTypes(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 16) {
    throw new SiwsError(400, "allowed_asset_types must be an array of at most 16 slugs");
  }
  for (const slug of v) {
    if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
      throw new SiwsError(400, "allowed_asset_types contains an invalid slug");
    }
  }
  return v as string[];
}

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(
      request,
      "adminConfig.jurisdictionsUpsert",
    );
    await requireAdmin(wallet);

    const mode = typeof params.mode === "string" ? params.mode : "";
    if (mode !== "insert" && mode !== "update") {
      throw new SiwsError(400, "mode must be 'insert' or 'update'");
    }
    const code = typeof params.code === "string" ? params.code.trim() : "";
    if (!CODE_RE.test(code)) {
      throw new SiwsError(400, "code must be an ISO-3166 numeric code");
    }
    if (!isPlainObject(params.row)) {
      throw new SiwsError(400, "row must be an object");
    }
    const row = params.row;

    // ---- shared field narrowing (each optional for update, most required
    // for insert — checked below) -----------------------------------------
    const patch: Record<string, unknown> = {};

    if (row.name !== undefined) {
      if (typeof row.name !== "string" || row.name.trim().length === 0 || row.name.trim().length > 120) {
        throw new SiwsError(400, "name must be 1–120 characters");
      }
      patch.name = row.name.trim();
    }
    if (row.alpha2 !== undefined) {
      if (row.alpha2 === null) patch.alpha2 = null;
      else if (typeof row.alpha2 === "string" && ALPHA2_RE.test(row.alpha2)) {
        patch.alpha2 = row.alpha2;
      } else throw new SiwsError(400, "alpha2 must be two uppercase letters or null");
    }
    if (row.region !== undefined) {
      if (row.region === null) patch.region = null;
      else if (typeof row.region === "string" && row.region.trim().length <= 60) {
        patch.region = row.region.trim() || null;
      } else throw new SiwsError(400, "region must be at most 60 characters or null");
    }
    if (row.kyc_level !== undefined) {
      if (typeof row.kyc_level !== "string" || !KYC_LEVELS.has(row.kyc_level)) {
        throw new SiwsError(400, "Unknown kyc_level");
      }
      patch.kyc_level = row.kyc_level;
    }
    if (row.risk_tier !== undefined) {
      if (typeof row.risk_tier !== "string" || !RISK_TIERS.has(row.risk_tier)) {
        throw new SiwsError(400, "Unknown risk_tier");
      }
      patch.risk_tier = row.risk_tier;
    }
    if (row.allowed_asset_types !== undefined) {
      patch.allowed_asset_types = parseAssetTypes(row.allowed_asset_types);
    }
    if (row.notes !== undefined) {
      if (typeof row.notes !== "string" || row.notes.length > 2000) {
        throw new SiwsError(400, "notes must be at most 2000 characters");
      }
      patch.notes = row.notes;
    }
    for (const flag of ["enabled_sale", "enabled_otc", "enabled_claim"] as const) {
      if (row[flag] !== undefined) {
        if (typeof row[flag] !== "boolean") {
          throw new SiwsError(400, `${flag} must be a boolean`);
        }
        patch[flag] = row[flag];
      }
    }

    const sb = getSupabaseAdmin();

    if (mode === "insert") {
      if (patch.name === undefined) throw new SiwsError(400, "name is required");
      const riskTier = (patch.risk_tier as string | undefined) ?? "medium";
      const enabled = riskTier !== "prohibited";
      const { error } = await sb.from("jurisdictions").insert({
        code,
        name: patch.name,
        alpha2: patch.alpha2 ?? null,
        region: patch.region ?? null,
        kyc_level: (patch.kyc_level as string | undefined) ?? "basic",
        risk_tier: riskTier,
        allowed_asset_types: patch.allowed_asset_types ?? [],
        notes: (patch.notes as string | undefined) ?? "",
        enabled_sale: enabled,
        enabled_otc: enabled,
        enabled_claim: enabled,
      });
      if (error) {
        if (error.code === "23505") {
          throw new SiwsError(409, "A jurisdiction with this code already exists");
        }
        console.error("[api/admin-config/jurisdictions-upsert] insert failed:", error.message);
        throw new SiwsError(500, "Could not add the jurisdiction");
      }
      return NextResponse.json({ ok: true, data: { code, mode } });
    }

    // ---- update -----------------------------------------------------------
    if (Object.keys(patch).length === 0) {
      throw new SiwsError(400, "row must contain at least one field to update");
    }
    const { data: existing, error: readError } = await sb
      .from("jurisdictions")
      .select("risk_tier")
      .eq("code", code)
      .maybeSingle();
    if (readError) {
      console.error("[api/admin-config/jurisdictions-upsert] read failed:", readError.message);
      throw new SiwsError(500, "Could not update the jurisdiction");
    }
    if (!existing) throw new SiwsError(404, "Jurisdiction not found");

    const effectiveRisk =
      (patch.risk_tier as string | undefined) ?? (existing.risk_tier as string);
    if (effectiveRisk === "prohibited") {
      // A prohibited jurisdiction can never have live flows.
      patch.enabled_sale = false;
      patch.enabled_otc = false;
      patch.enabled_claim = false;
    }

    const { error } = await sb
      .from("jurisdictions")
      .update(patch)
      .eq("code", code);
    if (error) {
      console.error("[api/admin-config/jurisdictions-upsert] update failed:", error.message);
      throw new SiwsError(500, "Could not update the jurisdiction");
    }

    return NextResponse.json({ ok: true, data: { code, mode } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
