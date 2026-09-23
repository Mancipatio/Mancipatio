// SERVER-ONLY — shared pieces of the wallet-less sign-in routes.

import "server-only";
import { NextResponse } from "next/server";
import { detectNetwork } from "@/lib/network";
import { SiwsError } from "@/lib/server/siws";
import { accountSiteOrigin } from "@/lib/server/account-origin";
import { ACCOUNT_COOKIE, ACCOUNT_SESSION_TTL_MS, accountCookieOptions, issueAccountSession } from "@/lib/server/account-auth";

/** Sign-in POSTs must come from our own pages (no cross-site form posts). */
export function assertSameSite(request: Request): string {
  const origin = accountSiteOrigin(request);
  if (request.headers.get("origin") !== origin) throw new SiwsError(403, "Please sign in from the Manci website.");
  return origin;
}

export function withAccountSession(response: NextResponse, accountId: string, origin: string): NextResponse {
  const { token } = issueAccountSession(accountId, detectNetwork(), origin);
  response.cookies.set(ACCOUNT_COOKIE, token, accountCookieOptions(origin, Math.floor(ACCOUNT_SESSION_TTL_MS / 1000)));
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function clearAccountSession(response: NextResponse, origin: string): NextResponse {
  response.cookies.set(ACCOUNT_COOKIE, "", accountCookieOptions(origin, 0));
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const LOGIN_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** /api/auth/email/start body cap: an address (≤254 characters) plus a
 *  Turnstile token (≤2048) and the JSON around them. */
export const EMAIL_START_BODY_LIMIT = 4096;

/** Sign-in links sent to all addresses together, per network and window.
 *  The DB limiter takes 1–100 hits per window of at most a day; a short
 *  window lets a burst delay sign-in links for minutes, not an hour. At most
 *  ≈300 links per hour. */
export const GLOBAL_LOGIN_EMAIL_LIMIT = 50;
export const GLOBAL_LOGIN_EMAIL_WINDOW_SECONDS = 600;
