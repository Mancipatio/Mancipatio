// SERVER-ONLY — HMAC-signed wallet session cookie for read-only requests.
//
// POST /api/auth/session exchanges ONE wallet signature (action "auth.session")
// for an httpOnly, SameSite=Strict cookie bound to wallet + network + origin.
// verifySigned() accepts it only for SESSION_READ_ACTIONS; writes still need a
// fresh signature. Without SESSION_SECRET sessions are disabled (fail closed:
// the client falls back to signing every request).

import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { SESSION_COOKIE, SESSION_TTL_MS } from "@/lib/siws-session";

export type WalletSessionClaims = { w: string; n: string; o: string; iat: number; exp: number; v: 1 };

function secret(): Buffer | null {
  const raw = process.env.SESSION_SECRET?.trim();
  return raw && raw.length >= 32 ? Buffer.from(raw, "utf8") : null;
}

export function sessionsEnabled(): boolean {
  return secret() !== null;
}

function mac(key: Buffer, body: string): string {
  return createHmac("sha256", key).update(`manci:session:v1:${body}`).digest("base64url");
}

export function issueSessionToken(wallet: string, network: string, origin: string, now = Date.now()): { token: string; claims: WalletSessionClaims } | null {
  const key = secret();
  if (!key) return null;
  const claims: WalletSessionClaims = { w: wallet, n: network, o: origin, iat: now, exp: now + SESSION_TTL_MS, v: 1 };
  const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return { token: `${body}.${mac(key, body)}`, claims };
}

export function readSessionToken(token: string | null | undefined, now = Date.now()): WalletSessionClaims | null {
  const key = secret();
  if (!key || !token || token.length > 1024) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const expected = Buffer.from(mac(key, body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as WalletSessionClaims;
    if (claims.v !== 1 || typeof claims.w !== "string" || typeof claims.n !== "string" || typeof claims.o !== "string" ||
        typeof claims.exp !== "number" || typeof claims.iat !== "number" || claims.exp <= now || claims.iat > now + 60_000) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Read the session cookie from a raw Request (route handlers get plain Requests). */
export function sessionCookieFrom(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=") || null;
  }
  return null;
}

export function sessionCookieOptions(origin: string, maxAgeSeconds: number) {
  return {
    httpOnly: true, secure: origin.startsWith("https:"), sameSite: "strict" as const,
    path: "/api", maxAge: maxAgeSeconds,
  };
}
