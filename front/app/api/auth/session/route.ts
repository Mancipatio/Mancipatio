// POST /api/auth/session — exchange one wallet signature ("auth.session") for
// a read-only session cookie. DELETE clears it (wallet disconnect / switch).
// Writes never accept the cookie; see lib/siws-session.ts.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { boundedRequest } from "@/lib/server/bounded-request";
import { detectNetwork } from "@/lib/network";
import { SESSION_COOKIE } from "@/lib/siws-session";
import { issueSessionToken, sessionCookieOptions, sessionsEnabled } from "@/lib/server/siws-session";
import { getAccountProfile } from "@/lib/server/account-profile";
import { MaintenanceError } from "@/lib/server/maintenance";

function noStore(response: NextResponse) {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(request: Request) {
  try {
    if (!sessionsEnabled()) throw new SiwsError(503, "Wallet sessions are not available");
    const origin = new URL(request.url).origin;
    const cloned = await boundedRequest(request, 4096);
    const body = await cloned.clone().json().catch(() => null) as { payload?: { origin?: unknown } } | null;
    const { wallet } = await verifySigned(cloned, "auth.session");
    // verifySigned pinned payload.origin to the configured site origin.
    const signedOrigin = typeof body?.payload?.origin === "string" ? body.payload.origin : origin;
    const network = detectNetwork();
    const issued = issueSessionToken(wallet, network, signedOrigin);
    if (!issued) throw new SiwsError(503, "Wallet sessions are not available");
    // Record the authenticated wallet before its first KYC/KYB submission.
    // This idempotently reuses a linked account and never creates a dossier.
    // Maintenance must still allow read sessions and existing-position exits;
    // a new contact profile can be created after maintenance ends.
    try {
      await getAccountProfile(wallet, network);
    } catch (error) {
      if (!(error instanceof MaintenanceError)) throw error;
    }
    const response = NextResponse.json({ ok: true, data: { wallet, network: issued.claims.n, expires_at: new Date(issued.claims.exp).toISOString() } });
    response.cookies.set(SESSION_COOKIE, issued.token, sessionCookieOptions(signedOrigin, Math.floor((issued.claims.exp - Date.now()) / 1000)));
    return noStore(response);
  } catch (error) {
    return noStore(siwsErrorResponse(error));
  }
}

export async function DELETE(request: Request) {
  const response = NextResponse.json({ ok: true, data: { cleared: true } });
  response.cookies.set(SESSION_COOKIE, "", sessionCookieOptions(new URL(request.url).origin, 0));
  return noStore(response);
}
