// SERVER-ONLY — account sessions for accounts that sign in with an email link
// or Google (no wallet needed), and the "actor" abstraction the account routes
// use: a request is authorized either by a wallet (SIWS signature / wallet
// session) or by the account session cookie.
//
// Account-session requests POST { payload: { v:2, origin, network, action,
// ts, nonce, params }, account: true }. They are bound to the site origin
// (the browser Origin header must match), the network, the action, a fresh
// timestamp and a single-use nonce; the cookie is httpOnly + SameSite=Strict.

import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { detectNetwork } from "@/lib/network";
import { SIWS_MAX_AGE_MS, type SiwsPayload } from "@/lib/siws-client";
import { assertRequestContext, consumeNonce, SiwsError, verifySigned } from "@/lib/server/siws";
import { assertActionWritable } from "@/lib/server/maintenance";

export const ACCOUNT_COOKIE = "manci_account";
export const ACCOUNT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONCE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Claims = { a: string; n: string; o: string; iat: number; exp: number; v: 1 };

function key(): Buffer | null {
  const raw = process.env.SESSION_SECRET?.trim();
  return raw && raw.length >= 32 ? Buffer.from(raw, "utf8") : null;
}
function mac(k: Buffer, body: string) {
  return createHmac("sha256", k).update(`manci:account:v1:${body}`).digest("base64url");
}

export function accountSessionsEnabled(): boolean { return key() !== null; }

export function issueAccountSession(accountId: string, network: string, origin: string, now = Date.now()) {
  const k = key();
  if (!k) throw new SiwsError(503, "Sign-in is not available right now.");
  const claims: Claims = { a: accountId, n: network, o: origin, iat: now, exp: now + ACCOUNT_SESSION_TTL_MS, v: 1 };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return { token: `${body}.${mac(k, body)}`, claims };
}

export function accountCookieOptions(origin: string, maxAgeSeconds: number) {
  return { httpOnly: true, secure: origin.startsWith("https:"), sameSite: "strict" as const, path: "/", maxAge: maxAgeSeconds };
}

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [n, ...rest] = part.trim().split("=");
    if (n === name) return rest.join("=") || null;
  }
  return null;
}

/** The live account session on this request, or null. */
export function readAccountSession(request: Request, now = Date.now()): Claims | null {
  const k = key();
  const token = cookieValue(request, ACCOUNT_COOKIE);
  if (!k || !token || token.length > 1024) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const expected = Buffer.from(mac(k, body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Claims;
    if (c.v !== 1 || !UUID.test(c.a) || c.n !== detectNetwork() || c.exp <= now) return null;
    return c;
  } catch { return null; }
}

export type Actor =
  | { kind: "wallet"; wallet: string; params: Record<string, unknown> }
  | { kind: "account"; accountId: string; params: Record<string, unknown> };

/**
 * Authorize an account-route request as a wallet (signature / wallet session)
 * or as the signed-in account (cookie). `request` must already be bounded.
 */
export async function readActor(request: Request, action: string): Promise<Actor> {
  let body: unknown = null;
  // Unparseable bodies take the wallet path, whose verifier reports the error.
  try { body = await request.clone().json(); } catch { body = null; }
  const b = body as { account?: unknown; payload?: Record<string, unknown> } | null;
  if (!b || b.account !== true) {
    const { wallet, params } = await verifySigned(request, action);
    return { kind: "wallet", wallet, params };
  }
  const payload = b.payload;
  if (!payload || typeof payload !== "object") throw new SiwsError(400, "Missing payload");
  const { v, origin, network, action: signedAction, ts, nonce, params } = payload as Record<string, unknown>;
  if (v !== 2 || typeof ts !== "string" || typeof nonce !== "string" || !NONCE_RE.test(nonce) ||
      !params || typeof params !== "object" || Array.isArray(params)) throw new SiwsError(400, "Malformed payload");
  assertRequestContext(request, origin, network);
  // Account requests must come from the site itself (no cross-site POST).
  if (request.headers.get("origin") !== origin) throw new SiwsError(401, "Request origin does not match");
  if (signedAction !== action) throw new SiwsError(401, "Action does not match this endpoint");
  const tsMs = Date.parse(ts);
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > SIWS_MAX_AGE_MS) throw new SiwsError(401, "Request expired");
  const session = readAccountSession(request);
  if (!session || session.o !== origin) throw new SiwsError(401, "Please sign in again.");
  // Same maintenance rule as wallet requests, before the nonce is spent.
  await assertActionWritable(action, detectNetwork());
  await consumeNonce({ v: 2, origin: origin as string, network: network as SiwsPayload["network"], action,
    wallet: `account:${session.a}`, ts, nonce, params: params as Record<string, unknown> }, tsMs + SIWS_MAX_AGE_MS);
  return { kind: "account", accountId: session.a, params: params as Record<string, unknown> };
}

/** The wallet address or account id the account functions act for. */
export function actorWho(actor: Actor): string | { accountId: string } {
  return actor.kind === "wallet" ? actor.wallet : { accountId: actor.accountId };
}
