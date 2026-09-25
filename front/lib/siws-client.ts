// SIWS "signed fetch" — client half of the stateless per-request auth protocol.
//
// Protocol (v2):
//   payload = { v: 2, origin, network, action, wallet, ts, nonce, params }
//   message = "mancipatio:v2:" + canonicalJson(payload)   (sorted keys, no whitespace)
//   signature = ed25519 sign of the UTF-8 message bytes by the connected wallet
//               — or, for a Ledger, of a Solana off-chain message whose body is
//               that message with non-ASCII characters \u-escaped, so the device
//               shows it in full (lib/siws-offchain.ts, lib/siws-signing.ts)
//   POST { payload, signature: base64, publicKey: wallet, sigFormat } to the route
//   (sigFormat: "raw" | "offchain-v0" | "offchain-v0-legacy"; absent = "raw";
//   a hint only — the server rebuilds and tries every accepted byte string)
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
import { isSessionReadAction, SESSION_TTL_MS } from "@/lib/siws-session";
import { assertNotInKnownMaintenance, MAINTENANCE_CODE, maintenanceRefusal, refusedInMaintenance } from "@/lib/maintenance";
import type { SiwsSignatureFormat } from "@/lib/siws-offchain";
import { signSiwsMessage } from "@/lib/siws-signing";

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
  /** Base64-encoded 64-byte ed25519 signature over the bytes `sigFormat` names. */
  signature: string;
  /** Redundant copy of payload.wallet (server requires equality). */
  publicKey: string;
  /** Which bytes were signed: the message itself ("raw", the default) or a
   * Solana off-chain message around it. A hint: the server rebuilds and
   * tries every accepted byte string, the named one first. */
  sigFormat?: SiwsSignatureFormat;
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
  // Don't ask for a signature the server would refuse: once the page knows
  // maintenance is on (banner poll or an earlier refusal), stop here.
  if (refusedInMaintenance(action)) assertNotInKnownMaintenance();

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
  // One prompt; a Ledger that refuses raw bytes gets one off-chain retry.
  // Throws instead of returning a signature it has proved the server rejects.
  const { signature, sigFormat } = await signSiwsMessage(
    session, signMessage, siwsMessage(payload), payload.wallet,
  );
  return {
    payload,
    signature: toBase64(signature),
    publicKey: payload.wallet,
    sigFormat,
  };
}

// ── Wallet session (read-only requests) ──────────────────────────────────────
// One signature ("auth.session") sets an httpOnly cookie; read-only actions
// then skip the wallet prompt. The browser only remembers WHICH wallet the
// cookie belongs to and until when — the server re-verifies every request.

const SESSION_HINT_KEY = "manci:wallet-session:v1";
let sessionHint: { wallet: string; network: string; origin: string; exp: number } | null = null;
let sessionInFlight: { wallet: string; promise: Promise<boolean> } | null = null;

function loadHint() {
  if (sessionHint) return sessionHint;
  try {
    const raw = window.localStorage.getItem(SESSION_HINT_KEY);
    if (raw) sessionHint = JSON.parse(raw);
  } catch { sessionHint = null; }
  return sessionHint;
}

function saveHint(hint: typeof sessionHint) {
  sessionHint = hint;
  try {
    if (hint) window.localStorage.setItem(SESSION_HINT_KEY, JSON.stringify(hint));
    else window.localStorage.removeItem(SESSION_HINT_KEY);
  } catch { /* storage may be blocked; the in-memory hint still works */ }
}

function hasSession(wallet: string): boolean {
  const hint = loadHint();
  return !!hint && hint.wallet === wallet && hint.network === detectNetwork() &&
    hint.origin === window.location.origin && hint.exp > Date.now() + 60_000;
}

/** True when this browser holds a live read session for `wallet` (no prompt needed). */
export function hasWalletSession(wallet: string): boolean {
  if (typeof window === "undefined") return false;
  return hasSession(wallet);
}

/** Forget the session (wallet disconnect or switch). Best-effort cookie clear. */
export function clearWalletSession() {
  saveHint(null);
  if (typeof window !== "undefined") void fetch("/api/auth/session", { method: "DELETE", cache: "no-store" }).catch(() => {});
}

async function startSession(session: WalletSession): Promise<boolean> {
  const wallet = session.account.address.toString();
  if (sessionInFlight?.wallet === wallet) return sessionInFlight.promise;
  const promise = (async () => {
    try {
      const body = await createSignedRequest(session, "auth.session", {});
      const res = await fetch("/api/auth/session", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), cache: "no-store",
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: { expires_at?: string } } | null;
      if (!res.ok || json?.ok !== true) return false;
      const exp = Date.parse(json.data?.expires_at ?? "");
      saveHint({ wallet, network: detectNetwork(), origin: window.location.origin,
        exp: Number.isFinite(exp) ? exp : Date.now() + SESSION_TTL_MS });
      return true;
    } finally {
      sessionInFlight = null;
    }
  })();
  sessionInFlight = { wallet, promise };
  return promise;
}

async function postEnvelope<T>(path: string, body: unknown): Promise<{ status: number; ok: boolean; data?: T; error?: string }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  type Envelope = { ok?: boolean; data?: unknown; error?: string; code?: string; message?: string };
  let json: Envelope | null = null;
  try {
    json = (await res.json()) as Envelope;
  } catch {
    // A proxy can return a non-JSON error response.
  }
  // A maintenance refusal is typed (callers keep its wording) and shows the banner.
  if (json?.code === MAINTENANCE_CODE) throw maintenanceRefusal(json.message, detectNetwork());
  if (!res.ok || !json || json.ok !== true) {
    return { status: res.status, ok: false, error: json?.error ?? `Request failed (${res.status} ${res.statusText})` };
  }
  return { status: res.status, ok: true, data: json.data as T };
}

function unsignedPayload(session: WalletSession, action: string, params: Record<string, unknown>): SiwsPayload {
  return {
    v: 2, origin: window.location.origin, network: detectNetwork(), action,
    wallet: session.account.address.toString(), ts: new Date().toISOString(),
    nonce: crypto.randomUUID(), params,
  };
}

/** A background read found no usable wallet session and was told not to sign. */
export class WalletSessionRequiredError extends Error {
  constructor(message = "No wallet session for this background read") {
    super(message);
    this.name = "WalletSessionRequiredError";
  }
}

/**
 * How far signedFetch may go to authorize a request:
 *   * `true` (the default) — today's behaviour: a session read starts the
 *     session when there is none (one prompt) and, if the session is refused,
 *     signs the request itself (a second prompt);
 *   * `"session-only"` — may start the session (one prompt) but never signs
 *     the request itself: no session afterwards, a refused start, a failing
 *     /api/auth/session or a 401 over the session all end in
 *     WalletSessionRequiredError;
 *   * `false` — never prompts: only a live session is used, and a 401 over it
 *     forgets the hint and throws WalletSessionRequiredError.
 * The last two accept session read actions only (anything else throws before
 * any request). Background reads (the admin menu counts) use them.
 */
export type SignedFetchInteractive = boolean | "session-only";

async function sessionOnlyRead<T>(
  session: WalletSession | null | undefined,
  path: string,
  action: string,
  params: Record<string, unknown>,
  mayStart: boolean,
): Promise<T> {
  if (!session) throw new WalletSessionRequiredError("Wallet not connected");
  const wallet = session.account.address.toString();
  let ready = hasSession(wallet);
  if (!ready && mayStart && session.signMessage) {
    try {
      ready = await startSession(session);
    } catch {
      // Declined, or a wallet error: the caller decides whether to ask again.
      ready = false;
    }
  }
  if (!ready) throw new WalletSessionRequiredError();
  const result = await postEnvelope<T>(path, { payload: unsignedPayload(session, action, params), session: true });
  if (result.ok) return result.data as T;
  if (result.status === 401) {
    saveHint(null);
    throw new WalletSessionRequiredError("The wallet session expired");
  }
  throw new Error(result.error);
}

/** Sign and POST to a same-origin API; mutations still need semantic idempotency.
 * Read-only actions use the wallet session and only prompt once per session;
 * `opts.interactive` limits the prompts of a background read (see above). */
export async function signedFetch<T = unknown>(
  session: WalletSession | null | undefined,
  path: string,
  action: string,
  params: Record<string, unknown> = {},
  opts: { interactive?: SignedFetchInteractive } = {},
): Promise<T> {
  const interactive = opts.interactive ?? true;
  if (interactive !== true && !isSessionReadAction(action)) {
    throw new Error(`"${action}" needs a wallet signature; only session reads can run without one`);
  }
  if (typeof window === "undefined") {
    throw new Error("Wallet requests must be signed from the app");
  }
  const destination = new URL(path, window.location.origin);
  if (destination.origin !== window.location.origin) {
    throw new Error("Signed requests must stay on the app origin");
  }
  if (interactive !== true) {
    return sessionOnlyRead<T>(session, path, action, params, interactive === "session-only");
  }
  if (session && isSessionReadAction(action)) {
    const wallet = session.account.address.toString();
    let ready = hasSession(wallet);
    if (!ready && session.signMessage) ready = await startSession(session);
    if (ready) {
      const result = await postEnvelope<T>(path, { payload: unsignedPayload(session, action, params), session: true });
      if (result.ok) return result.data as T;
      if (result.status !== 401) throw new Error(result.error);
      // Session expired or rejected server-side: forget it and sign this one.
      saveHint(null);
    }
  }
  const body = await createSignedRequest(session, action, params);
  const result = await postEnvelope<T>(path, body);
  if (!result.ok) throw new Error(result.error);
  return result.data as T;
}
