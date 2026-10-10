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
//   - MAINNET: an SSC approval clears the offering for sale
//     (lib/whitepaper-approval.ts offeringClearance), so recording or changing
//     one (status, reference, decision document, or a new whitepaper file
//     under an approval) needs the SUPER admin and the verified decision
//     document (ssc_decision_version_id) — the bar the offering exemption
//     has. Withdrawing an approval stays open to any admin.
//   - the offering exemption (offering_exemption_ref / _reason, 0076) is
//     admin-only too, and recording one needs the SUPER admin; the server
//     stamps offering_exemption_recorded_by / _at and writes an audit event.
//
// Archive (lib/archive.ts, /api/archive/set): a patch can neither set status
// "archived" nor write to an archived profile (409: unarchive first), and
// `fields.archive` is the archive route's alone (kept like sale_request).
//
// `fields.sale_request` (a public-sale request, lib/server/sale-requests) is
// written only by /api/sale-requests/*: a patch never sets it, and a patch
// that writes `fields` keeps the stored request (the tokenize flow's "Save
// details" sends `fields` whole).
//
// Client wrapper: upsertAssetProfile() in lib/asset-profiles.ts
// (action "profiles.upsert"). Fail closed on any RPC failure (503).

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin, requireSuperAdmin } from "@/lib/server/admin-gate";
import { actorSourceOf, writeServerAudit } from "@/lib/server/audit";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { requireDocumentVersion } from "@/lib/server/document-versions";
import { requireProfileOwner } from "@/lib/server/profile-read";
import { requireArea } from "@/lib/server/feature-gate";
import { protectSaleRequest } from "@/lib/server/sale-requests";
import { protectArchive } from "@/lib/archive";

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

/** Nullish and blank compare equal: an unchanged field re-sent by the form. */
function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (v === undefined || v === "" ? null : v);
  return norm(a) === norm(b);
}

/**
 * Whether the patch records or changes an SSC approval: the row ends up
 * ssc_approved and the status, a decision field or the whitepaper file
 * differs from what is stored. Re-saving an approved profile unchanged (the
 * admin form re-sends the reference) is not a change.
 */
function changesSscApproval(
  existing: Record<string, unknown> | null,
  cleaned: Record<string, unknown>,
  effectiveStatus: unknown,
  changedFile: boolean,
): boolean {
  if (effectiveStatus !== "ssc_approved") return false;
  if (existing?.whitepaper_status !== "ssc_approved" || changedFile) return true;
  return [...SSC_FIELDS].some((key) => key in cleaned && !sameValue(cleaned[key], existing?.[key]));
}

/**
 * The offering exemption (migration 0076): counsel's reference and the reason
 * a mainnet sale may run without an SSC-approved whitepaper
 * (lib/whitepaper-approval.ts offeringClearance). Recording one is a SUPER
 * ADMIN decision; any admin may clear it (the stricter direction). Both are
 * set together or cleared together, and the server stamps who and when.
 */
const EXEMPTION_FIELDS = new Set(["offering_exemption_ref", "offering_exemption_reason"]);

/**
 * Server-controlled fields — silently stripped from any patch. `created_by`
 * is stamped from the verified wallet like the issuer profile's: first
 * writer wins (kept once set; a row without one gets this writer).
 */
const STRIPPED_FIELDS = new Set([
  "network", "created_by", "created_at", "updated_at", "whitepaper_version_id", "ssc_decision_version_id", "whitepaper_published_at",
  "offering_exemption_recorded_by", "offering_exemption_recorded_at",
]);

/** Validates an exemption patch: both fields strings (set) or both null (clear). */
function exemptionPatch(cleaned: Record<string, unknown>): { ref: string; reason: string } | null {
  const ref = cleaned.offering_exemption_ref;
  const reason = cleaned.offering_exemption_reason;
  if ((ref === null || ref === undefined || ref === "") && (reason === null || reason === undefined || reason === "")) {
    return null;
  }
  if (typeof ref !== "string" || typeof reason !== "string") {
    throw new SiwsError(400, "An offering exemption needs both counsel's reference and the reason");
  }
  const r = ref.trim();
  const why = reason.trim();
  if (r.length < 3 || r.length > 200) throw new SiwsError(400, "offering_exemption_ref must be 3-200 characters");
  if (why.length < 10 || why.length > 1000) throw new SiwsError(400, "offering_exemption_reason must be 10-1000 characters");
  return { ref: r, reason: why };
}

const MAX_PROFILE_JSON = 50_000;


function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The fields of a take-down: components/asset-detail.tsx setPublished(false). */
const TAKE_DOWN_FIELDS = new Set(["asset_pda", "category", "issuer_pda", "status", "is_published"]);

/**
 * True for a patch that only takes the profile down (is_published=false,
 * status draft or untouched, nothing else): the Unpublish button. An exit,
 * open in KYC-only mode like a listing's take-down.
 */
function isProfileTakeDown(cleaned: Record<string, unknown>): boolean {
  return (
    cleaned.is_published === false &&
    (cleaned.status === undefined || cleaned.status === "draft") &&
    Object.keys(cleaned).every((key) => TAKE_DOWN_FIELDS.has(key))
  );
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
    const { wallet, params, via } = await verifySigned(request, "profiles.upsert");

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
    const touchesExemption = Object.keys(cleaned).some((k) => EXEMPTION_FIELDS.has(k));
    if (!admin) {
      // KYC-only mode (lib/features.ts): editing or publishing a profile is an
      // issuance entry; taking it down (Unpublish) stays open.
      if (!isProfileTakeDown(cleaned)) requireArea("issuance");
      if (touchesSsc) {
        throw new SiwsError(
          403,
          "SSC approval fields can only be set by a platform admin",
        );
      }
      if (touchesExemption) {
        throw new SiwsError(403, "An offering exemption can only be recorded by the platform");
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

    // Offering exemption (admin path only; the issuer path was refused above).
    // Only a patch that names the fields touches the 0076 columns, so a
    // deployment whose database predates 0076 keeps saving every other field.
    let exemption: { ref: string; reason: string } | null = null;
    if (touchesExemption) {
      exemption = exemptionPatch(cleaned);
      if (exemption) await requireSuperAdmin(wallet);
      cleaned.offering_exemption_ref = exemption?.ref ?? null;
      cleaned.offering_exemption_reason = exemption?.reason ?? null;
      cleaned.offering_exemption_recorded_by = exemption ? wallet : null;
      cleaned.offering_exemption_recorded_at = exemption ? new Date().toISOString() : null;
    }

    const sb = getSupabaseAdmin();
    const current = await sb.from("asset_profiles").select("fields,status,whitepaper_path,whitepaper_sha256,whitepaper_status,whitepaper_version_id,whitepaper_published_at,ssc_decision_ref,ssc_decision_doc_path,ssc_decision_doc_sha256,ssc_decision_version_id,created_by")
      .eq("asset_pda",assetPda).eq("network",detectNetwork()).maybeSingle();
    if(current.error) throw new SiwsError(503,"Current document version unavailable");
    const existing = current.data;
    // Archive is its own route (it records who, when and why).
    if (existing?.status === "archived") {
      throw new SiwsError(409, "This asset is archived — unarchive it first (Admin → Assets → Unarchive)");
    }
    if (cleaned.status === "archived") {
      throw new SiwsError(400, "Archive an asset with its Archive action: it asks for the reason and writes the audit log");
    }
    // created_by: first writer wins (see STRIPPED_FIELDS).
    cleaned.created_by = (typeof existing?.created_by === "string" && existing.created_by) || wallet;
    // The public-sale request is the sale-requests routes' alone (see header).
    if (isPlainObject(cleaned.fields)) {
      const storedFields: unknown = existing?.fields;
      const stored = isPlainObject(storedFields) ? storedFields : null;
      cleaned.fields = protectArchive(protectSaleRequest(cleaned.fields, stored), stored);
    }
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

    // Mainnet: recording or changing an SSC approval is a super-admin
    // decision backed by the verified decision document (see header).
    if (detectNetwork() === "mainnet" && changesSscApproval(existing, cleaned, effective.whitepaper_status, changedFile)) {
      await requireSuperAdmin(wallet);
      const decisionVersion = "ssc_decision_version_id" in cleaned
        ? cleaned.ssc_decision_version_id
        : existing?.ssc_decision_version_id;
      if (!decisionVersion) {
        throw new SiwsError(
          409,
          "On mainnet an SSC approval needs the verified decision document: upload it with the decision reference",
        );
      }
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

    // The row itself records who set the exemption and when; the audit event
    // is best effort on top (the write above already happened).
    if (touchesExemption) {
      try {
        await writeServerAudit(sb, {
          ix_name: exemption ? "offering_exemption_record" : "offering_exemption_clear",
          category: "assets",
          actor_wallet: wallet,
          actor_source: actorSourceOf(via),
          reason: exemption ? exemption.reason : "Offering exemption cleared",
          target_label: assetPda,
          metadata: { network: detectNetwork(), offering_exemption_ref: exemption?.ref ?? null },
        });
      } catch (auditErr) {
        console.warn(
          "[api/profiles/upsert] exemption audit event not written:",
          auditErr instanceof Error ? auditErr.message : String(auditErr),
        );
      }
    }

    return NextResponse.json({ ok: true, data: { asset_pda: assetPda } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
