// POST /api/issuer-profiles/upsert — off-chain issuer onboarding profile
// (company name / contact email / website), keyed by the Issuer PDA.
//
// Signed route with a TWO-TIER authorization model (SD4 pattern):
//   1. platform admin (on-chain Admin PDA / super admin), OR
//   2. wallet == Issuer.authority of the on-chain Issuer account at
//      `issuer_pda` (fresh finalized RPC owner + PDA validation, so
//      the onboarding flow right after register_issuer confirms is not
//      poisoned while RPC catches up).
//
// `network`, `created_by` and the timestamps are server-controlled:
// `created_by` keeps its original value once set (first writer wins),
// otherwise it is stamped from the SIWS-verified wallet.
//
// Client wrapper: upsertIssuerProfile() in lib/issuer-profiles.ts
// ("issuer-profiles.upsert").

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { requireProfileOwner } from "@/lib/server/profile-read";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** column -> max length for the writable text columns. */
const TEXT_FIELDS: Record<string, number> = {
  legal_entity_id: 64,
  company_name: 200,
  contact_email: 200,
  website: 500,
};

/** Server-controlled fields — silently stripped from any patch. */
const STRIPPED_FIELDS = new Set([
  "network",
  "created_by",
  "created_at",
  "updated_at",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Non-throwing admin probe: 403 -> false; 503 propagates (fail closed). */
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
    const { wallet, params } = await verifySigned(
      request,
      "issuer-profiles.upsert",
    );

    if (!isPlainObject(params.profile)) {
      throw new SiwsError(400, "Missing profile");
    }
    const profile = params.profile;

    const issuerPda =
      typeof profile.issuer_pda === "string" ? profile.issuer_pda.trim() : "";
    if (!BASE58_RE.test(issuerPda)) {
      throw new SiwsError(400, "issuer_pda must be a base58 address");
    }

    // Strict allowlist — reject unknown keys, strip server-controlled ones.
    const cleaned: Record<string, unknown> = { issuer_pda: issuerPda };
    for (const [key, value] of Object.entries(profile)) {
      if (key === "issuer_pda" || value === undefined) continue;
      if (STRIPPED_FIELDS.has(key)) continue;
      if (key in TEXT_FIELDS) {
        if (
          value !== null &&
          (typeof value !== "string" || value.length > TEXT_FIELDS[key])
        ) {
          throw new SiwsError(400, `Invalid value for profile field "${key}"`);
        }
        cleaned[key] = value;
      } else {
        throw new SiwsError(400, `Unknown profile field "${key}"`);
      }
    }

    // ---- Authorization: admin OR the on-chain Issuer.authority. ----
    const admin = await isAdminWallet(wallet);
    if (!admin) {
      await requireProfileOwner(wallet, issuerPda, "issuer");
    }

    const sb = getSupabaseAdmin();

    // created_by: first writer wins — keep the stored value if the row exists.
    const { data: existing, error: readError } = await sb
      .from("issuer_profiles")
      .select("created_by")
      .eq("issuer_pda", issuerPda)
      .eq("network", detectNetwork())
      .maybeSingle();
    if (readError) throw new SiwsError(503, "Profile read unavailable");
    const createdBy = (existing?.created_by as string | null) ?? wallet;

    const { error } = await sb
      .from("issuer_profiles")
      .upsert(
        { network: detectNetwork(), ...cleaned, created_by: createdBy },
        { onConflict: "network,issuer_pda" },
      );
    if (error) {
      console.error("[api/issuer-profiles/upsert] upsert failed:", error.message);
      throw new SiwsError(500, "Profile write failed");
    }

    return NextResponse.json({ ok: true, data: { issuer_pda: issuerPda } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
