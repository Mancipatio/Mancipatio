// POST /api/clients/onboarding-requirements — token-authed read of a client's
// own KYC requirements (the checklist the onboarding page shows).
//
// kyc_requirements has no anon SELECT (part of the KYC pipeline). The onboarding
// page authenticates with its magic-link token (same credential as
// /api/clients/onboarding-view), and the query is bound to that client_id, so a
// caller can only read the requirements of the client whose token they hold.
// Each row is returned as a FIXED PROJECTION (REQUIREMENT_VIEW_KEYS): what the
// checklist renders, never who requested it (`requested_by` is a staff wallet
// or a system key — the GDPR export masks it too, _privacy.ts
// OPERATOR_COLUMNS) nor the document and audit columns.
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

const REQUIREMENT_VIEW_KEYS = [
  "id",
  "doc_kind",
  "label",
  "note",
  "status",
  "requested_at",
] as const;

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
      .select(REQUIREMENT_VIEW_KEYS.join(", "))
      .eq("client_id", clientId)
      .order("requested_at", { ascending: false });
    if (error) {
      console.error(
        "[api/clients/onboarding-requirements] query failed:",
        error.message,
      );
      throw new SiwsError(500, "Could not load your requirements");
    }

    // Projected in JS as well as in the select list: a wider select later
    // (or a stand-in that ignores the columns) still returns only these keys.
    const requirements = ((data ?? []) as unknown as Record<string, unknown>[]).map((row) =>
      Object.fromEntries(REQUIREMENT_VIEW_KEYS.map((key) => [key, row[key] ?? null])),
    );
    return NextResponse.json({ ok: true, data: { requirements } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
