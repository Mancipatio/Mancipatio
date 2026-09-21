// POST /api/auth/session — exchange one wallet signature ("auth.session") for
// a read-only session cookie. DELETE clears it (wallet disconnect / switch).
// Writes never accept the cookie; see lib/siws-session.ts.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { boundedRequest } from "@/lib/server/bounded-request";
import { detectNetwork } from "@/lib/network";
import { SESSION_COOKIE } from "@/lib/siws-session";
import { issueSessionToken, sessionCookieOptions, sessionsEnabled } from "@/lib/server/siws-session";

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
    const issued = issueSessionToken(wallet, detectNetwork(), signedOrigin);
    if (!issued) throw new SiwsError(503, "Wallet sessions are not available");
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
