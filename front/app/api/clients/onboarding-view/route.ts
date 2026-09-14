// POST /api/clients/onboarding-view — token-authed read of a client's own row.
//
// The onboarding page needs its client row (name, type, KYC status, ToS state)
// AND to know whether its magic-link token is valid — but clients.onboarding_token
// is a BEARER SECRET that must never be read by the browser's anon Supabase
// client (W3-RLS revokes `select (onboarding_token)` from the anon role). So the
// token is validated SERVER-SIDE here (against clients.onboarding_token) and the
// row is returned with onboarding_token STRIPPED. Body: { client_id, token }.
//
// Requires the Node runtime (service-role client). 401 on an invalid token.

import { NextResponse } from "next/server";
import { SiwsError, siwsErrorResponse } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import {
  assertUuid,
  clientIpOf,
  rateLimited,
  requireClientToken,
} from "../_helpers";

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
    const row = await requireClientToken(sb, clientId, b.token);

    // Never return the bearer secret to the browser.
    const { onboarding_token: _secret, ...safe } = row;
    void _secret;
    return NextResponse.json({ ok: true, data: safe });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
