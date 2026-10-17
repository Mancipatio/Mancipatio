// POST /api/clients/onboarding-view — token-authed read of a client's own
// onboarding view.
//
// The onboarding page needs a few fields of its dossier (name, type, KYC
// status, ToS state, the linked wallet) AND to know whether its magic-link
// token is valid — but clients.onboarding_token is a BEARER SECRET that must
// never be read by the browser's anon Supabase client (W3-RLS revokes
// `select (onboarding_token)` from the anon role). So the token is validated
// SERVER-SIDE here (against clients.onboarding_token) and a FIXED PROJECTION
// of the row is returned (ONBOARDING_VIEW_KEYS, the same pattern as
// /api/clients/me SELF_KEYS): never the token, and never the dossier's
// internal columns (tags, tier, source, provider references, account id,
// notes) — anyone holding the link would otherwise read internal risk
// labels. `account_owned` says whether the dossier belongs to a wallet-less
// (email/Google) account, which accepts the Terms and uploads without a
// wallet (isAccountOwnedDossier). Body: { client_id, token }.
//
// Requires the Node runtime (service-role client). 401 on an invalid token.

import { NextResponse } from "next/server";
import { SiwsError, siwsErrorResponse } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import {
  assertUuid,
  clientIpOf,
  isAccountOwnedDossier,
  rateLimited,
  requireClientToken,
} from "../_helpers";

// What the onboarding page renders — nothing else leaves the dossier. The
// wallet stays an address (the page compares it with the connected wallet).
const ONBOARDING_VIEW_KEYS = [
  "id",
  "type",
  "display_name",
  "kyc_status",
  "onboarding_status",
  "wallet",
  "tos_accepted_at",
  "tos_version",
] as const;

export async function POST(request: Request) {
  try {
    // Token guessing / PII sweep guard (same pattern as /api/passport/status).
    if (rateLimited(`onboarding-view:${clientIpOf(request)}`, 30, 60_000)) {
      throw new SiwsError(429, "Too many requests — slow down");
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new SiwsError(400, "Invalid JSON body");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new SiwsError(400, "Invalid request body");
    }
    const b = body as Record<string, unknown>;
    const clientId = assertUuid(b.client_id, "client_id");

    const sb = getSupabaseAdmin();
    // Validates the presented token against clients.onboarding_token (401 else).
    // requireClientToken reads the whole row: it needs the token columns.
    const row = await requireClientToken(sb, clientId, b.token);

    // A projection in JS, not only a select list: the bearer secret and the
    // internal columns never reach the browser, whatever the row carries.
    const view = Object.fromEntries(
      ONBOARDING_VIEW_KEYS.map((key) => [key, row[key] ?? null]),
    );
    return NextResponse.json({
      ok: true,
      data: { ...view, account_owned: isAccountOwnedDossier(row) },
    });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
