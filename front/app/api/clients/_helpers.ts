// SERVER-ONLY shared helpers for the clients / ToS route handlers.
// Underscore-prefixed file → never routed; only route.ts files are served.
//
// Two auth modes exist in this domain (see app/api/_exemplar/route.ts):
//   * admin actions  — SIWS signed envelope (verifySigned) + requireAdmin
//   * magic-link     — the onboarding token is the credential; validated here
//     against clients.onboarding_token (requireClientToken)
//
// NOTE: these helpers deliberately do NOT import from lib/clients.ts — that
// module is marked "use client" (it uses the anon browser Supabase client).
// The few shared literals (statuses, doc kinds) are duplicated below; keep
// them in sync with lib/clients.ts.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { SiwsError } from "@/lib/server/siws";
import { detectNetwork } from "@/lib/network";

// ── Allowlists (keep in sync with lib/clients.ts) ───────────────────────────
export const CLIENT_TYPES = ["issuer", "investor", "delegate", "officer"] as const;
export const KYC_STATUSES = [
  "pending",
  "verified",
  "rejected",
  "suspended",
  "expired",
  "more_info",
] as const;
export const ONBOARDING_STATUSES = [
  "invited",
  "connected",
  "verified",
  "rejected",
  "completed",
] as const;
export const NOTE_KINDS = ["note", "communication", "kyc-event", "system"] as const;

export type ServerKycStatus = (typeof KYC_STATUSES)[number];

// ── Storage buckets ─────────────────────────────────────────────────────────
/** Private bucket for KYC documents (created by W3-RLS in 0025). */
export const PRIVATE_BUCKET = "client-documents";
/** Hard cap for uploaded KYC documents. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

// ── KYC lifecycle policy ────────────────────────────────────────────────────
/** Off-chain KYC validity window stamped at verification (kyc_expires_at). */
export const KYC_VALIDITY_DAYS = 365;
/** Magic-link onboarding token TTL (see migration 0041). */
export const ONBOARDING_TOKEN_TTL_DAYS = 14;
/** Remaining token validity after a successful link-wallet (rotation-lite). */
export const ONBOARDING_TOKEN_POST_LINK_DAYS = 7;

/** ISO expiry for a token issued right now (14-day TTL). */
export function onboardingTokenExpiry(now: Date = new Date()): string {
  return new Date(
    now.getTime() + ONBOARDING_TOKEN_TTL_DAYS * 24 * 3600 * 1000,
  ).toISOString();
}

// ── Param narrowing (manual validation — no zod) ────────────────────────────

export function reqString(
  params: Record<string, unknown>,
  key: string,
  maxLen: number,
): string {
  const v = params[key];
  if (typeof v !== "string" || v.trim().length === 0 || v.length > maxLen) {
    throw new SiwsError(400, `${key} must be a 1–${maxLen} character string`);
  }
  return v.trim();
}

export function optString(
  params: Record<string, unknown>,
  key: string,
  maxLen: number,
): string | null {
  const v = params[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || v.length > maxLen) {
    throw new SiwsError(400, `${key} must be a string of at most ${maxLen} characters`);
  }
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function oneOf<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new SiwsError(400, `${label} must be one of: ${allowed.join(", ")}`);
  }
  return value as T[number];
}

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function assertBase58Wallet(value: unknown, label = "wallet"): string {
  if (typeof value !== "string" || !BASE58_RE.test(value.trim())) {
    throw new SiwsError(400, `${label} is not a valid base58 pubkey`);
  }
  return value.trim();
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value: unknown, label = "id"): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new SiwsError(400, `${label} must be a UUID`);
  }
  return value;
}

export function assertPositiveInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new SiwsError(400, `${label} must be a positive integer`);
  }
  return value;
}

/** Sanitize a path segment used inside a Storage object key. */
export function safePathSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "_");
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") {
    throw new SiwsError(400, "Invalid path segment");
  }
  return cleaned;
}

// ── One canonical network resolver for server and client ────────────────────
export const detectNetworkServer = detectNetwork;

// ── Best-effort rate limiting (in-memory, per serverless instance) ──────────
// Shared by the token-authed onboarding routes and /api/passport/submit.
// Same trusted-header logic as /api/passport/status: prefer the platform-set
// x-real-ip, else the RIGHTMOST x-forwarded-for hop (the leftmost token is
// attacker-controlled). NOTE: each serverless instance keeps its own map, so
// this bounds bursts per instance only — a shared store (Upstash/KV) is the
// real remedy for a distributed flood.
const rateHits = new Map<string, number[]>();

export function clientIpOf(request: Request): string {
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const hops = xff
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return "unknown";
}

/** True when `key` exceeded `max` hits inside the sliding `windowMs` window. */
export function rateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const windowStart = now - windowMs;
  const prev = (rateHits.get(key) ?? []).filter((t) => t > windowStart);
  if (prev.length >= max) {
    rateHits.set(key, prev);
    return true;
  }
  prev.push(now);
  rateHits.set(key, prev);
  if (rateHits.size > 10_000) {
    const oldest = rateHits.keys().next().value;
    if (oldest !== undefined) rateHits.delete(oldest);
  }
  return false;
}

// ── DB helpers ──────────────────────────────────────────────────────────────

export type DbClientRow = {
  id: string;
  created_at: string;
  onboarding_token: string | null;
  onboarding_token_expires_at?: string | null;
  wallet: string | null;
  email: string | null;
  kyc_status: string;
  tos_accepted_at: string | null;
  display_name: string;
  [key: string]: unknown;
};

export async function fetchClientOr404(
  sb: SupabaseClient,
  clientId: string,
): Promise<DbClientRow> {
  const { data, error } = await sb
    .from("clients")
    .select("*")
    .eq("id", clientId)
    .eq("network", detectNetwork())
    .maybeSingle();
  if (error) throw new SiwsError(500, "Database read failed");
  if (!data) throw new SiwsError(404, "Client not found");
  return data as DbClientRow;
}

/**
 * Magic-link credential check: the presented token must be non-empty, equal
 * to the row's onboarding_token AND not past its TTL. Clients created with a
 * pre-known wallet have a NULL token and can never authenticate this way.
 *
 * TTL: onboarding_token_expires_at (0041) when stamped; rows predating the
 * migration fall back to created_at + 14 days — a stale invite is a stale
 * credential either way.
 */
export async function requireClientToken(
  sb: SupabaseClient,
  clientId: string,
  token: unknown,
): Promise<DbClientRow> {
  if (typeof token !== "string" || token.trim().length === 0 || token.length > 128) {
    throw new SiwsError(401, "Invalid onboarding token");
  }
  const row = await fetchClientOr404(sb, clientId);
  if (!row.onboarding_token || row.onboarding_token !== token.trim()) {
    throw new SiwsError(401, "Invalid onboarding token");
  }
  // FAIL-CLOSED: an unparseable expiry (manual data fix, import, column type
  // drift) must reject the token, never grant it forever — mirrors
  // isOnboardingTokenExpired in lib/clients.ts.
  if (!isOnboardingTokenLive(row.created_at, row.onboarding_token_expires_at)) {
    throw new SiwsError(
      401,
      "This onboarding link has expired — ask the platform operator for a fresh invitation",
    );
  }
  return row;
}

/**
 * The expiry (epoch ms) THIS SERVER will enforce for a row's onboarding
 * token: the 0041 stamp when present, otherwise the created_at + 14d fallback
 * requireClientToken applies. Single source of truth — every route that hands
 * out a magic link must ask this before advertising the link, or it can mint
 * a token the very next request rejects.
 */
export function effectiveTokenExpiryMs(
  createdAt: string | null | undefined,
  stamp: string | null | undefined,
): number {
  if (typeof stamp === "string" && stamp.length > 0) return Date.parse(stamp);
  if (typeof createdAt !== "string") return Number.NaN;
  return Date.parse(createdAt) + ONBOARDING_TOKEN_TTL_DAYS * 24 * 3600 * 1000;
}

/** True when a token with this (created_at, stamp) pair is still accepted. */
export function isOnboardingTokenLive(
  createdAt: string | null | undefined,
  stamp: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  const expiresAtMs = effectiveTokenExpiryMs(createdAt, stamp);
  return Number.isFinite(expiresAtMs) && nowMs <= expiresAtMs;
}

/** Shown whenever a fresh token cannot be stamped (pre-0041 database). */
export const DEGRADED_TTL_MESSAGE =
  "Your document-upload link could not be issued because the platform database is missing the onboarding-token expiry column (migration 0041). Contact the compliance team — they can send you a working link once it is applied.";

// ── Terminal-status gate (fail-closed across ALL rows of a wallet) ───────────

/** KYC states only compliance can lift — self-service must fail closed. */
export const TERMINAL_KYC_STATUSES = ["suspended", "rejected"] as const;

/** True for a status only compliance can lift. */
export function isTerminalKycStatus(status: unknown): boolean {
  return (
    typeof status === "string" &&
    (TERMINAL_KYC_STATUSES as readonly string[]).includes(status)
  );
}

/**
 * Fail-closed terminal-status probe over EVERY clients row carrying `wallet`.
 *
 * The single-row "oldest wins" lookup that the self-service routes use to
 * FIND a dossier is NOT a safe basis for this gate: while a wallet can have
 * more than one row (historic data; 0041's unique index is the fix going
 * forward, and it is conditional — it is skipped when duplicates already
 * exist), suspending the NEWER dossier would leave the older `pending` row
 * answering for the wallet, and the suspension would be invisible to the
 * whole pipeline. Any terminal row therefore blocks the wallet.
 *
 * Returns the offending status, or null when the wallet is clear. Throws
 * (500) when the probe itself fails — never "assume clear".
 */
export async function terminalKycStatusForWallet(
  sb: SupabaseClient,
  wallet: string,
): Promise<string | null> {
  const { data, error } = await sb
    .from("clients")
    .select("kyc_status")
    .eq("wallet", wallet);
  if (error) {
    console.error(
      "[clients/_helpers] terminal-status probe failed:",
      error.message,
    );
    throw new SiwsError(500, "Client lookup failed");
  }
  const hit = (data ?? []).find((row) =>
    isTerminalKycStatus((row as { kyc_status?: unknown }).kyc_status),
  );
  return hit ? String((hit as { kyc_status: unknown }).kyc_status) : null;
}

/** 403s when ANY clients row for `wallet` is suspended/rejected. */
export async function assertWalletNotTerminal(
  sb: SupabaseClient,
  wallet: string,
): Promise<void> {
  const status = await terminalKycStatusForWallet(sb, wallet);
  if (status) {
    throw new SiwsError(
      403,
      `Your KYC dossier is ${status} — contact the compliance team; reapplying is disabled.`,
    );
  }
}

// ── Migration-0041 graceful degradation ─────────────────────────────────────
// Several routes stamp clients.onboarding_token_expires_at (added in 0041).
// Deploy order says "apply 0041 FIRST", but if code ever ships against a
// pre-0041 database the write must degrade to "no TTL stamp" (the server
// falls back to created_at + 14d) instead of 500-ing the whole KYC flow.

/** Column added by migration 0041. */
export const TTL_COLUMN = "onboarding_token_expires_at";

/**
 * True when a PostgREST error is "the 0041 column does not exist" (PGRST204
 * mentions the column name in its message). Callers retry the write once
 * without that column.
 */
export function isMissingTtlColumnError(
  error: { message?: string } | null | undefined,
): boolean {
  return Boolean(error?.message && error.message.includes(TTL_COLUMN));
}

/** Copy of `row` without the 0041 TTL column (for the pre-migration retry). */
export function withoutTtlColumn(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const rest = { ...row };
  delete rest[TTL_COLUMN];
  return rest;
}

/** Insert a client_notes row and refresh the parent's notes_count. */
export async function insertNote(
  sb: SupabaseClient,
  clientId: string,
  author: string,
  body: string,
  kind: (typeof NOTE_KINDS)[number] = "note",
): Promise<void> {
  const { error } = await sb.from("client_notes").insert({
    client_id: clientId,
    author,
    body,
    kind,
  });
  if (error) {
    console.warn("[api/clients] note insert failed:", error.message);
    return;
  }
  const { count } = await sb
    .from("client_notes")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId);
  if (count != null) {
    await sb.from("clients").update({ notes_count: count }).eq("id", clientId);
  }
}

/**
 * Shared kyc_status patch (mirrors lib/clients.ts updateClientStatus).
 *
 * Lifecycle side effects on `verified`:
 *   * kyc_verified_at is stamped and kyc_expires_at is set to
 *     `opts.kycExpiresAt` (when given) or now + KYC_VALIDITY_DAYS — this date
 *     is the single expiry source both for the /admin/kyc re-KYC tabs and for
 *     the on-chain passport expiry (issue flows read it back).
 *   * the onboarding magic-link token is invalidated — onboarding is complete
 *     and every further access is wallet-signed (request-docs re-issues a
 *     fresh token when documents are needed again).
 */
export async function applyClientStatus(
  sb: SupabaseClient,
  clientId: string,
  kycStatus: ServerKycStatus,
  onboardingStatus?: (typeof ONBOARDING_STATUSES)[number],
  opts?: { kycExpiresAt?: string },
): Promise<void> {
  const patch: Record<string, unknown> = { kyc_status: kycStatus };
  if (onboardingStatus) patch.onboarding_status = onboardingStatus;
  if (kycStatus === "verified") {
    const now = new Date();
    patch.kyc_verified_at = now.toISOString();
    patch.kyc_expires_at =
      opts?.kycExpiresAt ??
      new Date(now.getTime() + KYC_VALIDITY_DAYS * 24 * 3600 * 1000).toISOString();
    patch.onboarding_token = null;
    patch.onboarding_token_expires_at = null;
  }
  if (kycStatus === "suspended") patch.suspended_at = new Date().toISOString();
  let { error } = await sb.from("clients").update(patch).eq("id", clientId);
  if (error && isMissingTtlColumnError(error)) {
    // Pre-0041 database — retry without the TTL column so a KYC verdict never
    // 500s over a missing hygiene column (see deploy notes: apply 0041 first).
    console.warn(
      "[api/clients] 0041 not applied — retrying status patch without",
      TTL_COLUMN,
    );
    ({ error } = await sb
      .from("clients")
      .update(withoutTtlColumn(patch))
      .eq("id", clientId));
  }
  if (error) throw new SiwsError(500, "Status update failed");
}

/**
 * Server port of recomputeClientKycFromRequirements: a `more_info` client with
 * no remaining OPEN requirements (requested/rejected) flips back to `pending`.
 * Returns the new status, or null when nothing changed. Never throws.
 */
export async function recomputeKycFromRequirements(
  sb: SupabaseClient,
  clientId: string,
): Promise<ServerKycStatus | null> {
  const { data: clientRow, error: clientErr } = await sb
    .from("clients")
    .select("kyc_status")
    .eq("id", clientId)
    .single();
  if (clientErr || !clientRow) return null;
  if ((clientRow as { kyc_status: string }).kyc_status !== "more_info") return null;

  const { data: openReqs, error: reqErr } = await sb
    .from("kyc_requirements")
    .select("id")
    .eq("client_id", clientId)
    .in("status", ["requested", "rejected"])
    .limit(1);
  if (reqErr) {
    console.warn("[api/clients] recompute failed:", reqErr.message);
    return null;
  }
  if ((openReqs ?? []).length > 0) return null;

  try {
    await applyClientStatus(sb, clientId, "pending");
  } catch {
    return null;
  }
  return "pending";
}

/** SHA-256 hex of raw bytes (WebCrypto — available on the Node runtime). */
export async function sha256HexOf(buf: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  let out = "";
  for (let i = 0; i < bytes.length; i += 1)
    out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

/** Crypto-random 32-hex onboarding token (same shape as the old client code). */
export function randomOnboardingToken(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Resolve a client document to a 60-minute signed URL on the PRIVATE bucket.
 *
 * No public-bucket fallback: KYC documents must never be reachable through an
 * unauthenticated URL. Legacy pre-P1 rows whose objects still live in the
 * public `documents` bucket resolve to null until the files are moved into
 * `client-documents` (ops task) — that is a 404 for the admin, not a leak.
 */
export async function documentUrlFor(
  sb: SupabaseClient,
  storagePath: string,
): Promise<string | null> {
  const { data, error } = await sb.storage
    .from(PRIVATE_BUCKET)
    .createSignedUrl(storagePath, 3600);
  if (!error && data?.signedUrl) return data.signedUrl;
  console.warn(
    `[api/clients] no signed URL for "${storagePath}" — legacy public-bucket fallback removed; move the object into ${PRIVATE_BUCKET}`,
  );
  return null;
}
