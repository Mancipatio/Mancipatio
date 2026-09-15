// POST /api/profiles/upsert — off-chain asset profile create/update/publish
// (incl. whitepaper + SSC approval evidence fields from migration 0026).
//
// Signed route with a TWO-TIER authorization model:
//   1. platform admin (on-chain Admin PDA / super admin)  -> may write any field;
//   2. issuer path: wallet == Issuer.authority of the profile's on-chain
//      Asset (fresh finalized RPC: Asset.issuer -> Issuer.authority)
//      -> may write everything EXCEPT the SSC approval fields.
//
// SSC gating (server-enforced, item 2):
//   - whitepaper_status values "ssc_approval_pending" / "ssc_approved" and the
//     ssc_decision_* evidence fields are settable ONLY via requireAdmin;
//   - setting whitepaper_status = "ssc_approved" REQUIRES a decision
//     reference (in this patch or already stored on the row).
//
// Client wrapper: upsertAssetProfile() in lib/asset-profiles.ts
// (action "profiles.upsert"). Fail closed on any RPC failure (503).

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { requireDocumentVersion } from "@/lib/server/document-versions";
import { requireProfileOwner } from "@/lib/server/profile-read";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const WHITEPAPER_STATUSES = new Set([
  "none",
  "draft",
  "published",
  "ssc_approval_pending",
  "ssc_approved",
]);
const PROFILE_STATUSES = new Set(["draft", "published", "archived"]);

/** Admin-only fields (SSC approval evidence + SSC status values). */
const SSC_FIELDS = new Set([
  "ssc_decision_ref",
  "ssc_decision_doc_path",
  "ssc_decision_doc_sha256",
]);
const SSC_STATUS_VALUES = new Set(["ssc_approval_pending", "ssc_approved"]);

/** Server-controlled fields — silently stripped from any patch. */
const STRIPPED_FIELDS = new Set(["network", "created_at", "updated_at", "whitepaper_version_id", "ssc_decision_version_id", "whitepaper_published_at"]);

const MAX_PROFILE_JSON = 50_000;


function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Non-throwing admin probe: 403 -> false; 503 (RPC down) propagates so we
 *  never fall through to a weaker path while auth checks are blind. */
async function isAdminWallet(wallet: string): Promise<boolean> {
  try {
    await requireAdmin(wallet);
    return true;
  } catch (err) {
    if (err instanceof SiwsError && err.status === 403) return false;
    throw err;
  }
}

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "profiles.upsert");

    if (!isPlainObject(params.profile)) {
      throw new SiwsError(400, "Missing profile");
    }
    const profile = params.profile;

    const assetPda =
      typeof profile.asset_pda === "string" ? profile.asset_pda.trim() : "";
    if (!BASE58_RE.test(assetPda)) {
      throw new SiwsError(400, "asset_pda must be a base58 address");
    }
    const category =
      typeof profile.category === "string" ? profile.category.trim() : "";
    if (!category || category.length > 40) {
      throw new SiwsError(400, "category required (≤40 chars)");
    }

    // Value-shape sanitation: primitives, null, string[] (tags), or a plain
    // object (the dynamic `fields` column). Anything else is rejected.
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(profile)) {
      if (STRIPPED_FIELDS.has(key)) continue;
      if (key.length > 64) throw new SiwsError(400, "Invalid profile key");
      const t = typeof value;
      const okValue =
        value === null ||
        t === "string" ||
        (t === "number" && Number.isFinite(value as number)) ||
        t === "boolean" ||
        (Array.isArray(value) && value.every((x) => typeof x === "string")) ||
        (key === "fields" && isPlainObject(value));
      if (!okValue) {
        throw new SiwsError(400, `Invalid value for profile field "${key}"`);
      }
      cleaned[key] = value;
    }
    if (JSON.stringify(cleaned).length > MAX_PROFILE_JSON) {
      throw new SiwsError(400, "Profile payload too large");
    }
    cleaned.asset_pda = assetPda;

    const whitepaperStatus =
      typeof cleaned.whitepaper_status === "string"
        ? cleaned.whitepaper_status
        : undefined;
    if (
      whitepaperStatus !== undefined &&
      !WHITEPAPER_STATUSES.has(whitepaperStatus)
    ) {
      throw new SiwsError(400, "Unknown whitepaper status");
    }
    if (
      cleaned.status !== undefined &&
      (typeof cleaned.status !== "string" || !PROFILE_STATUSES.has(cleaned.status))
    ) {
      throw new SiwsError(400, "Unknown profile status");
    }

    // ---- Authorization: admin OR the asset's on-chain issuer authority. ----
    const admin = await isAdminWallet(wallet);
    const touchesSsc =
      Object.keys(cleaned).some((k) => SSC_FIELDS.has(k)) ||
      (whitepaperStatus !== undefined && SSC_STATUS_VALUES.has(whitepaperStatus));
    if (!admin) {
      if (touchesSsc) {
        throw new SiwsError(
          403,
          "SSC approval fields can only be set by a platform admin",
        );
      }
      await requireProfileOwner(wallet,assetPda,"asset");
      // SPV assignment is a Manci-team operation (SPVs are incorporated
      // and linked to a client by admins, and each issuance is booked against
      // that SPV's EUR 3M annual cap). An issuer must not be able to point
      // their asset at another client's SPV, so silently drop any spv_id an
      // issuer-path patch tries to set/change.
      if ("spv_id" in cleaned) {
        delete cleaned.spv_id;
      }
    }

    const sb = getSupabaseAdmin();
    const current = await sb.from("asset_profiles").select("whitepaper_path,whitepaper_sha256,whitepaper_status,whitepaper_version_id,whitepaper_published_at,ssc_decision_ref,ssc_decision_doc_path,ssc_decision_doc_sha256,ssc_decision_version_id")
      .eq("asset_pda",assetPda).eq("network",detectNetwork()).maybeSingle();
    if(current.error) throw new SiwsError(503,"Current document version unavailable");
    const existing = current.data;
    const changedFile = cleaned.whitepaper_path !== undefined && cleaned.whitepaper_path !== existing?.whitepaper_path;
    if(changedFile && existing?.whitepaper_status === "ssc_approved" && (!admin || !cleaned.ssc_decision_ref)) {
      cleaned.whitepaper_status="draft";
      cleaned.ssc_decision_ref=null;cleaned.ssc_decision_doc_path=null;cleaned.ssc_decision_doc_sha256=null;cleaned.ssc_decision_version_id=null;
    }
    const effective = {...existing,...cleaned};
    const publishing = ["published","ssc_approved"].includes(String(effective.whitepaper_status))
      && (cleaned.whitepaper_status !== undefined || changedFile);
    if(cleaned.whitepaper_path !== undefined || cleaned.whitepaper_sha256 !== undefined || publishing) {
      if(typeof effective.whitepaper_path === "string" && effective.whitepaper_path.startsWith(`whitepapers/${assetPda}/`)) {
        const version=await requireDocumentVersion("documents",effective.whitepaper_path,effective.whitepaper_sha256);
        cleaned.whitepaper_version_id=version.id;
        if(publishing) cleaned.whitepaper_published_at=changedFile || !existing?.whitepaper_published_at ? new Date().toISOString() : existing.whitepaper_published_at;
      } else {
        cleaned.whitepaper_version_id=null;
        if(publishing) throw new SiwsError(409,"Publish a verified uploaded whitepaper version. External links are supplementary references");
      }
    }
    if(cleaned.ssc_decision_doc_path !== undefined || cleaned.ssc_decision_doc_sha256 !== undefined) {
      const path=effective.ssc_decision_doc_path;
      if(path === null) cleaned.ssc_decision_version_id=null;
      else if(typeof path === "string" && path.startsWith(`whitepapers/${assetPda}/`)) {
        cleaned.ssc_decision_version_id=(await requireDocumentVersion("documents",path,effective.ssc_decision_doc_sha256)).id;
      } else throw new SiwsError(400,"SSC document must belong to this asset");
    }

    // ssc_approved requires decision evidence — from this patch or the row.
    if (cleaned.whitepaper_status === "ssc_approved") {
      let ref =
        typeof cleaned.ssc_decision_ref === "string"
          ? cleaned.ssc_decision_ref.trim()
          : "";
      if (!ref) {
        const { data: existing } = await sb
          .from("asset_profiles")
          .select("ssc_decision_ref")
          .eq("asset_pda", assetPda)
          .eq("network", detectNetwork())
          .maybeSingle();
        ref = (existing?.ssc_decision_ref as string | null)?.trim() ?? "";
      }
      if (!ref) {
        throw new SiwsError(
          400,
          "ssc_approved requires an SSC decision reference",
        );
      }
    }

    const { error } = await sb
      .from("asset_profiles")
      .upsert({ network: detectNetwork(), ...cleaned }, { onConflict: "network,asset_pda" });
    if (error) {
      console.error("[api/profiles/upsert] upsert failed:", error.message);
      throw new SiwsError(500, "Profile write failed");
    }

    return NextResponse.json({ ok: true, data: { asset_pda: assetPda } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
