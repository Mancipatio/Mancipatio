// POST /api/clients/onboarding-requirements — token-authed read of a client's
// own KYC requirements (the checklist the onboarding page shows).
//
// kyc_requirements has no anon SELECT (part of the KYC pipeline). The onboarding
// page authenticates with its magic-link token (same credential as
// /api/clients/onboarding-view), and the query is bound to that client_id, so a
// caller can only read the requirements of the client whose token they hold.
// Body: { client_id, token }.

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
    // Token guessing guard (same pattern as /api/passport/status).
    if (rateLimited(`onboarding-reqs:${clientIpOf(request)}`, 30, 60_000)) {
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
    await requireClientToken(sb, clientId, b.token);

    const { data, error } = await sb
      .from("kyc_requirements")
      .select("*")
      .eq("client_id", clientId)
      .order("requested_at", { ascending: false });
    if (error) {
      console.error(
        "[api/clients/onboarding-requirements] query failed:",
        error.message,
      );
      throw new SiwsError(500, "Could not load your requirements");
    }

    return NextResponse.json({ ok: true, data: { requirements: data ?? [] } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
