// SIWS "signed fetch" — client half of the stateless per-request auth protocol.
//
// Protocol (v2):
//   payload = { v: 2, origin, network, action, wallet, ts, nonce, params }
//   message = "mancipatio:v2:" + canonicalJson(payload)   (sorted keys, no whitespace)
//   signature = ed25519 sign of the UTF-8 message bytes by the connected wallet
//   POST { payload, signature: base64, publicKey: wallet } to the route
//
// The server half lives in lib/server/siws.ts (`verifySigned`). Both sides share
// `canonicalJson` and `SIWS_MESSAGE_PREFIX` from THIS file — do not fork the
// canonicalization logic.
//
// NOTE: this module is intentionally NOT marked "use client" — it contains no
// hooks/components, and the server imports the canonicalization helpers below.
// `signedFetch` itself only runs in the browser (it needs a WalletSession).

import type { WalletSession } from "@solana/client";
import { detectNetwork, type Network } from "@/lib/network";

/** Prefix prepended to the canonical JSON before signing. */
export const SIWS_MESSAGE_PREFIX = "mancipatio:v2:";

/** Max age of a signed payload, in milliseconds (server enforces the same). */
export const SIWS_MAX_AGE_MS = 300_000;

/** The exact payload shape that gets canonicalized and signed. */
export type SiwsPayload = {
  v: 2;
  /** Exact browser origin, pinned against the server's site configuration. */
  origin: string;
  /** Cluster the request is intended to authorize. */
  network: Network;
  /** Route-specific action id, e.g. "clients.create". Server pins it. */
  action: string;
  /** Base58 address of the signing wallet. */
  wallet: string;
  /** ISO-8601 timestamp (new Date().toISOString()). ±300s window. */
  ts: string;
  /** crypto.randomUUID() — atomically consumed in the shared server database. */
  nonce: string;
  /** Route-specific parameters (JSON-serializable, no undefined at top level). */
  params: Record<string, unknown>;
};

/** Wire shape POSTed to signed routes. */
export type SiwsRequestBody = {
  payload: SiwsPayload;
  /** Base64-encoded 64-byte ed25519 signature over the message bytes. */
  signature: string;
  /** Redundant copy of payload.wallet (server requires equality). */
  publicKey: string;
};

/**
 * Deterministic JSON: object keys sorted (recursively), no whitespace,
 * `undefined` object values dropped (mirrors JSON.stringify), `undefined`
 * array elements become null (mirrors JSON.stringify).
 *
 * MUST stay byte-identical to the server rebuild in lib/server/siws.ts —
 * which is why the server imports this exact function.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const s = JSON.stringify(value);
    return s === undefined ? "null" : s;
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalJson(v)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") +
    "}"
  );
}

/** Build the exact byte string a wallet signs for a given payload. */
export function siwsMessage(payload: SiwsPayload): string {
  return SIWS_MESSAGE_PREFIX + canonicalJson(payload);
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Build a signed envelope for JSON or multipart callers. The same v2 contract
 * applies everywhere; callers must not create a second, divergent payload.
 */
export async function createSignedRequest(
  session: WalletSession | null | undefined,
  action: string,
  params: Record<string, unknown> = {},
): Promise<SiwsRequestBody> {
  if (!session) throw new Error("Wallet not connected");
  const signMessage = session.signMessage;
  if (!signMessage) {
    throw new Error("Connected wallet does not support message signing");
  }
  if (typeof window === "undefined") {
    throw new Error("Wallet requests must be signed from the app");
  }

  const payload: SiwsPayload = {
    v: 2,
    origin: window.location.origin,
    network: detectNetwork(),
    action,
    wallet: session.account.address.toString(),
    ts: new Date().toISOString(),
    nonce: crypto.randomUUID(),
    params,
  };
  const signature = await signMessage(
    new TextEncoder().encode(siwsMessage(payload)),
  );
  return {
    payload,
    signature: toBase64(signature),
    publicKey: payload.wallet,
  };
}

/** Sign and POST to a same-origin API; mutations still need semantic idempotency. */
export async function signedFetch<T = unknown>(
  session: WalletSession | null | undefined,
  path: string,
  action: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  if (typeof window === "undefined") {
    throw new Error("Wallet requests must be signed from the app");
  }
  const destination = new URL(path, window.location.origin);
  if (destination.origin !== window.location.origin) {
    throw new Error("Signed requests must stay on the app origin");
  }
  const body = await createSignedRequest(session, action, params);
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  type Envelope = { ok?: boolean; data?: unknown; error?: string };
  let json: Envelope | null = null;
  try {
    json = (await res.json()) as Envelope;
  } catch {
    // A proxy can return a non-JSON error response.
  }
  if (!res.ok || !json || json.ok !== true) {
    throw new Error(
      json?.error ?? `Request failed (${res.status} ${res.statusText})`,
    );
  }
  return json.data as T;
}
