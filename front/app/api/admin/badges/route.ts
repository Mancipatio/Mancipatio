// POST /api/admin/badges — the "waiting for you" counts behind the admin menu
// (app/admin/layout.tsx). Signed session read ("admin.badges") +
// requireAdminOrKycProvider: an admin gets every admin page's count, the KYC
// provider only /admin/clients (without KYB) and /admin/kyc — the pages
// ADMIN_ROUTE_ACCESS opens for it. Counts only (head counts and id sets that
// never leave the server): no rows, no PII. One failing count is null, never
// a failed response. Sources and memo: lib/server/admin-badges.ts; the rules
// shared with the pages: lib/admin-badge-rules.ts.
//
// Params: { fresh?: true } — re-read now instead of the 10 s memo (sent right
// after an admin action). Client wrapper: fetchAdminBadges() in
// lib/admin-badges.ts, which never signs per request (session only).

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { requireAdminOrKycProvider } from "@/lib/server/kyc-provider-gate";
import { readAdminBadges } from "@/lib/server/admin-badges";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "admin.badges");
    const role = await requireAdminOrKycProvider(wallet);
    const data = await readAdminBadges({ wallet, role, fresh: params.fresh === true });
    return NextResponse.json({ ok: true, data }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}
