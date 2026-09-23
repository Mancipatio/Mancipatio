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

/** Per-IP sign-in links (the /64 prefix for IPv6), per hour. */
export const LOGIN_IP_LIMIT = 20;
/** Sign-in links to one address, per network and hour. */
export const LOGIN_EMAIL_LIMIT = 5;

/** Circuit breaker on sign-in links to all addresses together, per network:
 *  it bounds the damage a large distributed flood can do to the mail server's
 *  volume and reputation (≈6000 links an hour at most). It is set far above
 *  real sign-in traffic so it does not act as a throttle: filling it takes
 *  100 sends inside one minute (at LOGIN_IP_LIMIT per IP an hour: at least 5
 *  IPs or /64s, and about 300 new ones an hour to keep it full), and it clears one
 *  minute after the burst. The DB limiter takes 1–100 hits per window of at
 *  most a day. */
export const GLOBAL_LOGIN_EMAIL_LIMIT = 100;
export const GLOBAL_LOGIN_EMAIL_WINDOW_SECONDS = 60;

/** In-memory, per-instance burst cap on /api/auth/email/start per IP (or
 *  /64), checked before the Turnstile call so junk tokens cannot make
 *  unbounded siteverify calls. Looser than the DB caps for real users. */
export const EMAIL_START_BURST_LIMIT = 10;
export const EMAIL_START_BURST_WINDOW_MS = 60_000;
