// SERVER-ONLY — SIWS signature verification for signed routes.
// Client half (payload construction + canonicalization) is lib/siws-client.ts.
// Hardware wallets (Ledger) sign the same canonical text inside a Solana
// off-chain message; the envelope layouts, limits and the application-domain
// decision are in lib/siws-offchain.ts.
//
// Usage inside a route handler (see app/api/_exemplar/route.ts):
//
//   try {
//     const { wallet, params } = await verifySigned(request, "domain.action");
//     ...
//     return NextResponse.json({ ok: true, data });
//   } catch (err) {
//     return siwsErrorResponse(err);
//   }
//
// Requires the Node.js runtime (Buffer) — do NOT add `export const runtime =
// "edge"` to routes that use this.

import "server-only";

import { NextResponse } from "next/server";
import {
  address as toAddress,
  getPublicKeyFromAddress,
  signatureBytes,
  verifySignature,
} from "@solana/kit";
import {
  SIWS_MAX_AGE_MS,
  siwsMessage,
  type SiwsPayload,
} from "@/lib/siws-client";
import {
  isSiwsSignatureFormat,
  OffchainMessageLimitError,
  siwsSignedBytes,
  type SiwsSignatureFormat,
} from "@/lib/siws-offchain";
import { detectNetwork } from "@/lib/network";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { isSessionReadAction } from "@/lib/siws-session";
import { readSessionToken, sessionCookieFrom } from "@/lib/server/siws-session";
import { SiwsError } from "@/lib/server/siws-error";
import { assertActionWritable, MaintenanceError, maintenanceResponse } from "@/lib/server/maintenance";

export { SiwsError };

export type VerifiedRequest = {
  /** Base58 wallet address whose ed25519 signature verified. */
  wallet: string;
  /** The signed, route-specific params — still validate field-by-field. */
  params: Record<string, unknown>;
  /**
   * How the wallet was proven: a fresh signature over this request, or the
   * wallet session cookie (read actions only). Recorded by server audit rows.
   */
  via?: "signature" | "session";
};

const NONCE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Never derive production trust from a caller-controlled Host/forwarded header. */
export function assertRequestContext(request: Request, origin: unknown, network: unknown) {
  if (typeof origin !== "string" || origin.length > 255) {
    throw new SiwsError(400, "Missing or invalid signed origin");
  }
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new SiwsError(400, "Invalid signed origin");
  }
  if (originUrl.origin !== origin || !["https:", "http:"].includes(originUrl.protocol)) {
    throw new SiwsError(400, "Signed origin must be an HTTP origin without a path");
  }

  const allowedOrigins = new Set<string>();
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) {
    try {
      const site = new URL(configured);
      if (site.protocol !== "https:" && process.env.NODE_ENV === "production") {
        throw new Error("Production site must use HTTPS");
      }
      if (!["https:", "http:"].includes(site.protocol) || site.username || site.password) {
        throw new Error("Invalid site origin");
      }
      allowedOrigins.add(site.origin);
    } catch {
      throw new SiwsError(503, "Server site origin is not configured correctly");
    }
  }
  // Local development still works when the public site URL points at the real
  // site. This exception is disabled in production, including behind a proxy.
  if (process.env.NODE_ENV !== "production") {
    const local = new URL(request.url);
    if (["localhost", "127.0.0.1", "[::1]"].includes(local.hostname)) {
      allowedOrigins.add(local.origin);
    }
  }
  if (allowedOrigins.size === 0) {
    throw new SiwsError(503, "Server site origin is not configured");
  }
  if (!allowedOrigins.has(origin)) {
    throw new SiwsError(401, "Signature is for a different app origin");
  }
  const browserOrigin = request.headers.get("origin");
  if (browserOrigin !== null && browserOrigin !== origin) {
    throw new SiwsError(401, "Request origin does not match the signed origin");
  }
  if (network !== detectNetwork()) {
    throw new SiwsError(401, "Signature is for a different Solana network");
  }
}

export async function consumeNonce(payload: SiwsPayload, expiresAt: number): Promise<void> {
  try {
    const { data, error } = await getSupabaseAdmin().rpc("consume_siws_nonce", {
      p_origin: payload.origin,
      p_network: payload.network,
      p_wallet: payload.wallet,
      p_nonce: payload.nonce,
      p_expires_at: new Date(expiresAt).toISOString(),
    });
    if (error || typeof data !== "boolean") {
      // Do not log the signed params: they may contain private client data.
      console.error("[siws] shared nonce store unavailable", error?.code ?? "invalid response");
      throw new SiwsError(503, "Request verification unavailable — try again");
    }
    if (!data) throw new SiwsError(401, "Nonce already used or expired");
  } catch (error) {
    if (error instanceof SiwsError) throw error;
    console.error("[siws] shared nonce store unavailable");
    throw new SiwsError(503, "Request verification unavailable — try again");
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Verify SIWS v2, then consume its nonce in the shared database before returning
 * identity. Missing migration/database access fails closed. A valid signature
 * cannot be reused by another worker or after a server restart. This does not
 * replace transaction-level idempotency for newly signed duplicate intents.
 */
export async function verifySigned(
  request: Request,
  expectedAction: string,
): Promise<VerifiedRequest> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new SiwsError(400, "Invalid JSON body");
  }
  if (!isPlainObject(body)) throw new SiwsError(400, "Invalid request body");

  const { payload, signature, publicKey, session, sigFormat } = body as {
    payload?: unknown;
    signature?: unknown;
    publicKey?: unknown;
    session?: unknown;
    sigFormat?: unknown;
  };
  if (!isPlainObject(payload)) throw new SiwsError(400, "Missing payload");
  // Read-only requests may ride on a wallet session cookie instead of a
  // fresh signature (see lib/siws-session.ts). Everything else must sign.
  const viaSession = session === true;
  if (!viaSession) {
    if (typeof signature !== "string" || signature.length === 0) {
      throw new SiwsError(400, "Missing signature");
    }
    if (typeof publicKey !== "string" || publicKey.length === 0) {
      throw new SiwsError(400, "Missing publicKey");
    }
    // Which bytes the signature covers (lib/siws-offchain.ts). Only the NAME
    // of the layout comes from the client; the bytes are rebuilt below.
    if (sigFormat !== undefined && !isSiwsSignatureFormat(sigFormat)) {
      throw new SiwsError(400, "Unsupported signature format");
    }
  }

  const { v, origin, network, action, wallet, ts, nonce, params } = payload as {
    origin?: unknown;
    network?: unknown;
    v?: unknown;
    action?: unknown;
    wallet?: unknown;
    ts?: unknown;
    nonce?: unknown;
    params?: unknown;
  };
  if (v !== 2) throw new SiwsError(400, "Unsupported payload version");
  if (typeof action !== "string" || typeof wallet !== "string") {
    throw new SiwsError(400, "Malformed payload");
  }
  if (typeof ts !== "string" || typeof nonce !== "string") {
    throw new SiwsError(400, "Malformed payload");
  }
  if (!isPlainObject(params)) throw new SiwsError(400, "Malformed params");
  if (!NONCE_RE.test(nonce)) throw new SiwsError(400, "Nonce must be a random UUID");
  assertRequestContext(request, origin, network);

  if (action !== expectedAction) {
    throw new SiwsError(401, "Signed action does not match this endpoint");
  }
  if (!viaSession && publicKey !== wallet) {
    throw new SiwsError(401, "publicKey does not match payload wallet");
  }

  const now = Date.now();
  const tsMs = Date.parse(ts);
  if (Number.isNaN(tsMs) || Math.abs(now - tsMs) > SIWS_MAX_AGE_MS) {
    throw new SiwsError(401, "Signature expired or timestamp invalid");
  }

  if (viaSession) {
    if (!isSessionReadAction(action)) {
      throw new SiwsError(401, "This action requires a wallet signature");
    }
    const claims = readSessionToken(sessionCookieFrom(request), now);
    if (!claims || claims.w !== wallet || claims.n !== network || claims.o !== origin) {
      throw new SiwsError(401, "Wallet session expired — sign in again");
    }
    // Maintenance refuses before the nonce is spent (lib/server/maintenance.ts).
    await assertActionWritable(action, detectNetwork());
    await consumeNonce(payload as SiwsPayload, tsMs + SIWS_MAX_AGE_MS);
    return { wallet, params, via: "session" };
  }

  // Verify the exact signed context and params before touching the nonce store.
  // Invalid signatures must never reserve another wallet's nonce.
  // "raw" = the UTF-8 SIWS text itself; "offchain-v0*" = a Solana off-chain
  // message whose body is that same text (hardware wallets). Either way the
  // server derives the one byte string to check from the canonical payload.
  const format: SiwsSignatureFormat = (sigFormat as SiwsSignatureFormat | undefined) ?? "raw";
  let messageBytes: Uint8Array;
  try {
    messageBytes = siwsSignedBytes(siwsMessage(payload as SiwsPayload), wallet, format);
  } catch (error) {
    if (error instanceof OffchainMessageLimitError) throw new SiwsError(400, error.message);
    throw new SiwsError(401, "Invalid wallet address or signature");
  }
  let sigBytes: Uint8Array;
  try {
    sigBytes = new Uint8Array(Buffer.from(signature as string, "base64"));
    if (sigBytes.length !== 64) throw new Error("bad length");
  } catch {
    throw new SiwsError(400, "Signature is not valid base64 ed25519");
  }

  let verified = false;
  try {
    const cryptoKey = await getPublicKeyFromAddress(toAddress(wallet));
    verified = await verifySignature(
      cryptoKey,
      signatureBytes(sigBytes),
      messageBytes,
    );
  } catch {
    throw new SiwsError(401, "Invalid wallet address or signature");
  }
  if (!verified) {
    throw new SiwsError(401, "Signature verification failed");
  }

  // Writes (and the pre-send policy check) wait out maintenance. A refused
  // request does not spend its nonce; its signature still expires with ts.
  await assertActionWritable(action, detectNetwork());

  // Retain a future-dated request until its actual signed validity ends.
  await consumeNonce(payload as SiwsPayload, tsMs + SIWS_MAX_AGE_MS);

  return { wallet, params, via: "signature" };
}

/**
 * Map any thrown error to the house `{ ok: false, error }` JSON envelope.
 * SiwsError keeps its status; everything else becomes a 500 with a generic
 * message (details logged server-side, never leaked to the client).
 */
export function siwsErrorResponse(err: unknown): NextResponse {
  if (err instanceof MaintenanceError) return maintenanceResponse(err);
  if (err instanceof SiwsError) {
    return NextResponse.json(
      { ok: false, error: err.message },
      { status: err.status },
    );
  }
  console.error("[siws] unhandled route error:", err);
  return NextResponse.json(
    { ok: false, error: "Internal server error" },
    { status: 500 },
  );
}
