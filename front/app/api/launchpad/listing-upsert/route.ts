// POST /api/launchpad/listing-upsert — create/update a launchpad listing row.
//
// Signed route with a TWO-TIER authorization model:
//   1. platform admin (on-chain Admin PDA / super admin), OR
//   2. the issuer authority behind the sale
//      (Sale -> ShareClass -> Asset -> Issuer.authority, on-chain, 60s cache).
//
// Strict field allowlist mirroring public.launch_listings (0012); unknown
// keys are rejected, `created_at` is server-controlled.
//
// Client wrapper: upsertListing() in lib/launchpad.ts
// ("launchpad.listingUpsert").

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import {
  BASE58_RE,
  UUID_RE,
  isAdminWallet,
  isPlainObject,
  saleIssuerAuthority,
} from "../_lib";

/** column -> max length (for the free-text columns). */
const TEXT_FIELDS: Record<string, number> = {
  logo_letter: 8,
  logo_gradient: 300,
  problem: 10_000,
  why_now: 10_000,
  existing_investors: 10_000,
};

const MAX_TRACTION_JSON = 10_000;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(
      request,
      "launchpad.listingUpsert",
    );

    if (!isPlainObject(params.listing)) {
      throw new SiwsError(400, "Missing listing");
    }
    const listing = params.listing;

    const salePubkey =
      typeof listing.sale_pubkey === "string" ? listing.sale_pubkey.trim() : "";
    if (!BASE58_RE.test(salePubkey)) {
      throw new SiwsError(400, "sale_pubkey must be a base58 address");
    }

    // Strict allowlist — reject unknown keys instead of silently writing them.
    const cleaned: Record<string, unknown> = { sale_pubkey: salePubkey };
    for (const [key, value] of Object.entries(listing)) {
      if (key === "sale_pubkey" || value === undefined) continue;
      if (key === "application_id") {
        if (value !== null && (typeof value !== "string" || !UUID_RE.test(value))) {
          throw new SiwsError(400, "application_id must be a UUID or null");
        }
        cleaned[key] = value;
      } else if (key in TEXT_FIELDS) {
        if (value !== null && (typeof value !== "string" || value.length > TEXT_FIELDS[key])) {
          throw new SiwsError(400, `Invalid value for listing field "${key}"`);
        }
        cleaned[key] = value;
      } else if (key === "traction") {
        if (
          !isPlainObject(value) ||
          Object.values(value).some((v) => typeof v !== "string") ||
          JSON.stringify(value).length > MAX_TRACTION_JSON
        ) {
          throw new SiwsError(400, "traction must be a small string map");
        }
        cleaned[key] = value;
      } else if (key === "is_published") {
        if (typeof value !== "boolean") {
          throw new SiwsError(400, "is_published must be a boolean");
        }
        cleaned[key] = value;
      } else {
        throw new SiwsError(400, `Unknown listing field "${key}"`);
      }
    }

    const admin = await isAdminWallet(wallet);
    const issuer = await saleIssuerAuthority(salePubkey);
    if(!issuer) throw new SiwsError(404,"A verified on-chain sale is required");
    if(!admin && issuer !== wallet) throw new SiwsError(403,"Only the platform admin or sale issuer may edit this listing");
    const result = await getSupabaseAdmin().rpc("save_launch_listing",{
      p_network:detectNetwork(),p_sale:salePubkey,p_issuer:issuer,p_admin:admin,p_listing:cleaned,
    });
    if(result.error) {
      if(result.error.code === "P0001" || result.error.code === "23505") throw new SiwsError(409,result.error.message);
      throw new SiwsError(503,"Sale listing publication unavailable. Retry publishing the existing sale");
    }

    return NextResponse.json({ ok: true, data: { sale_pubkey: salePubkey } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
