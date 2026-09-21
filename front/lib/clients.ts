"use client";

// Clients / KYC domain — client half.
//
// P1 (W2-SD1): every WRITE in this module goes through a server route under
// /api/clients/* instead of the anon Supabase client:
//   * admin actions   — SIWS signed (signedFetch) + on-chain requireAdmin
//   * magic-link reads/uploads — scoped, expiring invitation token
//   * initial wallet link — invitation token AND signature of the linked wallet
// READS are now signed too — clients / client_notes / client_documents /
// kyc_requirements have NO anon SELECT (migration 0036); they hold the full
// client directory, internal notes and KYC pipeline data (PII). Reads go
// through:
//   * clients.adminList / adminDetail / lookup — SIWS + requireAdmin
//   * clients.me                                — SIWS, bound to the signer
//   * onboarding-view / onboarding-requirements — magic-link token, own row
//
// KYC document uploads land in the PRIVATE "client-documents" bucket via the
// service-role client server-side; admins read them through 60-minute signed
// URLs (getClientDocumentUrl). Legacy pre-P1 files in the public "documents"
// bucket keep working via a server-side fallback.

import type { WalletSession } from "@solana/client";
import {
  signedFetch,
  createSignedRequest,
} from "@/lib/siws-client";
import { TOS_VERSION } from "@/lib/tos-version";

/** Current Terms-of-Service version (single source: lib/tos-version.ts). */
export { TOS_VERSION };

export type ClientType = "issuer" | "investor" | "delegate" | "officer";
export type ClientKycStatus =
  | "pending"
  | "verified"
  | "rejected"
  | "suspended"
  | "expired"
  | "more_info";
export type OnboardingStatus =
  | "invited"
  | "connected"
  | "verified"
  | "rejected"
  | "completed";

export type ClientRow = {
  id: string;
  created_at: string;
  updated_at: string;
  network: string;
  type: ClientType;
  types: ClientType[];
  tier: string | null;
  tags: string[];
  source: string | null;
  email: string | null;
  display_name: string;
  company_name: string | null;
  jurisdiction: string | null;
  kyc_status: ClientKycStatus;
  kyc_provider: string | null;
  kyc_verified_at: string | null;
  kyc_expires_at: string | null;
  onboarding_token: string | null;
  /** Magic-link TTL (0041); absent from the admin-list projection. */
  onboarding_token_expires_at?: string | null;
  onboarding_status: OnboardingStatus;
  wallet: string | null;
  issuer_pda: string | null;
  suspended_at: string | null;
  notes_count: number;
  last_activity_at: string | null;
  tos_accepted_at: string | null;
  tos_version: string | null;
};

export type ClientNote = {
  id: number;
  created_at: string;
  client_id: string;
  author: string;
  body: string;
  kind: "note" | "communication" | "kyc-event" | "system";
};

export type ClientCreateInput = {
  types: ClientType[];
  email?: string;
  display_name: string;
  company_name?: string;
  jurisdiction?: string;
  tier?: string;
  source?: string;
  /**
   * Optional pre-known wallet. When set, the client is created in
   * `connected` onboarding state — they don't need to redeem a magic-link.
   * Useful when the admin already has the client's pubkey on file.
   */
  wallet?: string;
};

// ── Reads (signed routes) ───────────────────────────────────────────────────
//
// clients / client_notes / client_documents / kyc_requirements have no anon
// SELECT (migration 0036) — the whole directory + internal notes + KYC pipeline
// is PII. Admin reads are SIWS + requireAdmin; a wallet's own row is a signed
// self-read; onboarding uses its magic-link token.

/** Admin lists the client directory (signed + on-chain admin gate). THROWS. */
export async function listClients(
  session: WalletSession | null | undefined,
): Promise<ClientRow[]> {
  const data = await signedFetch<{ clients: ClientRow[] }>(
    session,
    "/api/clients/admin-list",
    "clients.adminList",
  );
  return data.clients ?? [];
}

/**
 * The connected wallet reads its OWN client row (KYC status), if any. Signed;
 * the server binds the query to the verified signer. Returns null when the
 * wallet is not linked to any client. THROWS on transport/auth errors.
 */
export async function getMyClient(
  session: WalletSession | null | undefined,
): Promise<ClientRow | null> {
  const data = await signedFetch<{ client: ClientRow | null }>(
    session,
    "/api/clients/me",
    "clients.me",
  );
  return data.client ?? null;
}

/**
 * The connected wallet's OWN document-upload (magic-link) path. Signed
 * self-read: /api/clients/me re-serves — and, when the stored token is
 * consumed/expired, freshly re-issues — the upload link for the verified
 * signer's dossier, so losing the one-time modal link never strands the
 * applicant. THROWS on transport/auth errors so the UI can show the server's
 * message.
 *
 * `path` is null when no upload is pending. In that case `notice` may carry a
 * server explanation to show instead of the generic "nothing to upload" copy
 * (today: the database is missing migration 0041, so a freshly issued token
 * would have no expiry stamp and the link would 401 immediately).
 */
export async function getMyOnboardingPath(
  session: WalletSession | null | undefined,
): Promise<{ path: string | null; notice: string | null }> {
  const data = await signedFetch<{
    client: ClientRow | null;
    onboarding_path: string | null;
    onboarding_notice?: string | null;
  }>(session, "/api/clients/me", "clients.me");
  return {
    path: data.onboarding_path ?? null,
    notice: data.onboarding_notice ?? null,
  };
}

/**
 * Admin looks up whether a specific wallet belongs to an onboarded client
 * (e.g. a mint destination). Signed + requireAdmin; single-wallet lookup, not a
 * directory dump. Returns null when unknown. THROWS on transport/auth errors
 * (callers treat a throw as "could not verify").
 */
export async function lookupClientByWallet(
  session: WalletSession | null | undefined,
  wallet: string,
): Promise<ClientRow | null> {
  const trimmed = wallet.trim();
  if (!trimmed) return null;
  const data = await signedFetch<{ client: ClientRow | null }>(
    session,
    "/api/clients/lookup",
    "clients.lookup",
    { wallet: trimmed },
  );
  return data.client ?? null;
}

/** Self-service KYC/KYB intake from /verify (client_verification_details). */
export type ClientVerificationDetails = {
  kind: "kyc" | "kyb";
  legal_name: string;
  date_of_birth: string | null;
  nationality: number | null;
  residence_country: number;
  address_line: string;
  city: string;
  postal_code: string;
  phone: string | null;
  email: string | null;
  company_name: string | null;
  company_reg_number: string | null;
  company_country: number | null;
  company_address: string | null;
  company_website: string | null;
  representative_role: string | null;
  submitted_by_wallet: string;
  submitted_at: string;
};

export type ClientDetail = {
  client: ClientRow;
  notes: ClientNote[];
  requirements: KycRequirement[];
  documents: ClientDocument[];
  verification?: ClientVerificationDetails[];
};

/**
 * Admin reads one client's full record — row, internal notes, KYC requirements
 * and document metadata — in a single signed request. THROWS on failure.
 */
export async function adminGetClientDetail(
  session: WalletSession | null | undefined,
  id: string,
): Promise<ClientDetail> {
  return await signedFetch<ClientDetail>(
    session,
    "/api/clients/admin-detail",
    "clients.adminDetail",
    { id },
  );
}

/**
 * Token-authed onboarding read: validates the magic-link token SERVER-SIDE and
 * returns the client row WITHOUT onboarding_token (the browser must never read
 * that bearer secret — W3-RLS revokes the column from the anon role). Used by
 * the onboarding page in place of getClient + a client-side token compare.
 * Returns { client: null, tokenValid: false } for a missing/invalid token.
 */
export async function getClientForOnboarding(
  clientId: string,
  token: string,
): Promise<{ client: ClientRow | null; tokenValid: boolean }> {
  if (!token) return { client: null, tokenValid: false };
  try {
    const res = await fetch("/api/clients/onboarding-view", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, token }),
    });
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; data?: ClientRow; error?: string }
      | null;
    if (!res.ok || !json || json.ok !== true || !json.data) {
      return { client: null, tokenValid: false };
    }
    return { client: json.data, tokenValid: true };
  } catch (err) {
    console.warn("[clients] onboarding view failed:", err);
    return { client: null, tokenValid: false };
  }
}

// Admin note/requirement/document READS are folded into adminGetClientDetail
// (one signed request per client-detail page load). listNotes / getClient /
// listClientDocuments were removed with the anon-read lockdown.

// ── Admin writes (SIWS signed routes) ───────────────────────────────────────
// Every function takes the connected WalletSession (useWalletConnection().wallet)
// as its FIRST parameter; the server verifies the signature and the on-chain
// Admin PDA before writing with the service-role client.

export async function createClient(
  session: WalletSession | null | undefined,
  input: ClientCreateInput,
): Promise<ClientRow | null> {
  const row = await signedFetch<ClientRow>(session, "/api/clients/create", "clients.create", {
    types: input.types,
    display_name: input.display_name,
    email: input.email ?? null,
    company_name: input.company_name ?? null,
    jurisdiction: input.jurisdiction ?? null,
    tier: input.tier ?? null,
    source: input.source ?? null,
    wallet: input.wallet ?? null,
  });
  return row ?? null;
}

/** Partial update of editable client fields. Keeps legacy `type` synced to types[0]. */
export async function updateClient(
  session: WalletSession | null | undefined,
  id: string,
  patch: Partial<
    Pick<
      ClientRow,
      | "display_name"
      | "email"
      | "company_name"
      | "jurisdiction"
      | "tier"
      | "source"
      | "tags"
      | "types"
    >
  >,
): Promise<boolean> {
  try {
    await signedFetch(session, "/api/clients/update", "clients.update", {
      id,
      ...patch,
    });
    return true;
  } catch (err) {
    console.warn("[clients] updateClient:", err);
    return false;
  }
}

/**
 * Admin KYC decision. When `reason` is given it is recorded as a timeline note
 * server-side (kyc-event; system for suspensions) — no separate addNote call
 * needed anymore.
 */
export async function updateClientStatus(
  session: WalletSession | null | undefined,
  id: string,
  kyc_status: ClientKycStatus,
  onboarding_status?: OnboardingStatus,
  reason?: string,
): Promise<void> {
  try {
    await signedFetch(session, "/api/clients/status", "clients.status", {
      id,
      kyc_status,
      onboarding_status: onboarding_status ?? null,
      reason: reason ?? null,
    });
  } catch (err) {
    console.warn("[clients] status update failed:", err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export async function suspendClient(
  session: WalletSession | null | undefined,
  id: string,
  reason?: string,
): Promise<void> {
  await signedFetch(session, "/api/clients/status", "clients.status", {
    id,
    kyc_status: "suspended",
    reason: reason ?? null,
  });
}

/**
 * Mirror the on-chain passport outcome into the off-chain dossier via the
 * signed KYC-provider route (POST /api/clients/passport-sync — authorized
 * against `KycRegistry.authority`, not `Platform.admin`, so a rotated
 * provider can still write back the transactions only it can send):
 *   * "issued"  → kyc_provider='manual', kyc_provider_ref=tx signature,
 *                 kyc_expires_at=on-chain expiry (+ approval email)
 *   * "revoked" → kyc_status='suspended' (+ notification email)
 * Best-effort from the caller's perspective: returns false on failure so the
 * tx flow can surface a warning without failing the already-sent transaction.
 *
 * Contract (mirrors the route's validation, e2e §4): an "issued" event MUST
 * carry the on-chain expiry as an ISO timestamp — the route answers 400
 * ("expires_at must be an ISO timestamp") otherwise, so the overloads make a
 * caller that drops it (the old /admin/kyc "Retry sync" did) a compile error,
 * and the runtime guard turns any remaining bad call into a `false` before a
 * request that could never succeed is signed. "revoked" carries no expiry.
 */
export async function syncPassportToClient(
  session: WalletSession | null | undefined,
  clientId: string,
  event: "issued",
  txSignature: string,
  expiresAtIso: string,
): Promise<boolean>;
export async function syncPassportToClient(
  session: WalletSession | null | undefined,
  clientId: string,
  event: "revoked",
  txSignature: string,
): Promise<boolean>;
export async function syncPassportToClient(
  session: WalletSession | null | undefined,
  clientId: string,
  event: "issued" | "revoked",
  txSignature: string,
  expiresAtIso?: string,
): Promise<boolean> {
  try {
    const params = passportSyncParams(clientId, event, txSignature, expiresAtIso);
    await signedFetch(session, "/api/clients/passport-sync", "clients.passport-sync", params);
    return true;
  } catch (err) {
    console.warn("[clients] passport sync failed:", err);
    return false;
  }
}

/**
 * Build the exact `params` object syncPassportToClient() signs. Exported
 * (pure, no wallet) so the route test can assert that what the UI sends is
 * what POST /api/clients/passport-sync accepts. Throws on the contract
 * violation the route would reject — an "issued" event without a parsable
 * ISO expiry — instead of signing a request that is 400 by construction.
 */
export function passportSyncParams(
  clientId: string,
  event: "issued" | "revoked",
  txSignature: string,
  expiresAtIso?: string,
): {
  client_id: string;
  event: "issued" | "revoked";
  tx_signature: string;
  expires_at: string | null;
} {
  if (event === "issued") {
    const ms = expiresAtIso ? Date.parse(expiresAtIso) : NaN;
    if (!Number.isFinite(ms)) {
      throw new Error(
        "passport sync: an 'issued' event requires the on-chain expiry as an ISO timestamp",
      );
    }
    return {
      client_id: clientId,
      event,
      tx_signature: txSignature,
      expires_at: new Date(ms).toISOString(),
    };
  }
  return { client_id: clientId, event, tx_signature: txSignature, expires_at: null };
}

/** Admin posts an internal note; the author is the verified signing wallet. */
export async function addNote(
  session: WalletSession | null | undefined,
  clientId: string,
  body: string,
  kind: ClientNote["kind"] = "note",
): Promise<void> {
  try {
    await signedFetch(session, "/api/clients/note", "clients.note", {
      client_id: clientId,
      body,
      kind,
    });
  } catch (err) {
    console.warn("[client_notes] insert failed:", err);
  }
}

// ── Magic-link (token-authed) writes — onboarding page ──────────────────────

/** Link only the wallet that signs this invitation, without signing the raw token. */
export async function linkClientWallet(
  session: WalletSession | null | undefined,
  clientId: string,
  token: string,
): Promise<void> {
  const invitationToken = token.trim();
  const tokenDigest = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(invitationToken),
  );
  const invitationHash = Array.from(new Uint8Array(tokenDigest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const envelope = await createSignedRequest(session, "clients.linkWallet", {
    client_id: clientId,
    invitation_hash: invitationHash,
  });
  const res = await fetch("/api/clients/link-wallet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...envelope, invitation_token: invitationToken }),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => null)) as
    | { ok?: boolean; error?: string }
    | null;
  if (!res.ok || !json || json.ok !== true) {
    throw new Error(json?.error ?? `Link failed (${res.status})`);
  }
}

/**
 * Record acceptance of the current ToS version for a magic-link client:
 * stamps the `clients` row, appends to the `tos_acceptances` log, and drops a
 * system note — all server-side. Never throws.
 *
 * (Wallet-only acceptance without a client row is the SIGNED route
 * /api/tos/accept — see app/api/tos/accept/route.ts.)
 */
export async function acceptTos(
  clientId: string,
  token: string,
  wallet: string,
): Promise<boolean> {
  try {
    const res = await fetch("/api/clients/accept-tos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, token, wallet: wallet || null }),
    });
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; error?: string }
      | null;
    if (!res.ok || !json || json.ok !== true) {
      console.warn("[clients] acceptTos failed:", json?.error ?? res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[clients] acceptTos threw:", err);
    return false;
  }
}

// ── Pure KYC lifecycle helpers (unit-tested in tests/kyc-pipeline.test.ts) ──
// Keep in sync with the server mirrors in app/api/clients/_helpers.ts (that
// module is server-only and cannot be shared with this "use client" module).

/** Off-chain KYC validity window stamped at verification (kyc_expires_at). */
export const KYC_VALIDITY_DAYS = 365;
/** Magic-link onboarding token TTL (see migration 0041). */
export const ONBOARDING_TOKEN_TTL_DAYS = 14;

/**
 * The recompute step of the KYC state machine: a `more_info` client with no
 * remaining OPEN requirements (requested/rejected) flips back to `pending`
 * for final review. Every other state is left untouched (returns null).
 * Server mirror: recomputeKycFromRequirements in app/api/clients/_helpers.ts.
 */
export function recomputeKycDecision(
  kycStatus: ClientKycStatus,
  openRequirements: number,
): ClientKycStatus | null {
  if (kycStatus !== "more_info") return null;
  if (openRequirements > 0) return null;
  return "pending";
}

/**
 * Magic-link TTL check. A token is expired when past its stamped
 * `expiresAt`; rows predating migration 0041 (null expiry) fall back to
 * `createdAt` + ONBOARDING_TOKEN_TTL_DAYS. A missing token is always
 * "expired" (there is nothing to redeem).
 * Server mirror: requireClientToken in app/api/clients/_helpers.ts.
 */
export function isOnboardingTokenExpired(
  token: string | null,
  expiresAt: string | null,
  createdAt: string,
  nowMs: number,
): boolean {
  if (!token) return true;
  const limit = expiresAt
    ? Date.parse(expiresAt)
    : Date.parse(createdAt) + ONBOARDING_TOKEN_TTL_DAYS * 24 * 3600 * 1000;
  if (!Number.isFinite(limit)) return true;
  return nowMs > limit;
}

// ── KYC document kinds (structured checklist) ───────────────────────────────
export type KycDocKind =
  | "passport"
  | "national_id"
  | "proof_of_address"
  | "selfie"
  | "incorporation"
  | "board_resolution"
  | "source_of_funds"
  | "bank_statement"
  | "other";

export const KYC_DOC_KINDS: { kind: KycDocKind; label: string }[] = [
  { kind: "passport", label: "Passport" },
  { kind: "national_id", label: "National ID" },
  { kind: "proof_of_address", label: "Proof of address" },
  { kind: "selfie", label: "Selfie / liveness" },
  { kind: "incorporation", label: "Certificate of incorporation" },
  { kind: "board_resolution", label: "Board resolution" },
  { kind: "source_of_funds", label: "Source of funds" },
  { kind: "bank_statement", label: "Bank statement" },
  { kind: "other", label: "Other document" },
];

export type KycRequirementStatus =
  | "requested"
  | "submitted"
  | "approved"
  | "rejected";

export type KycRequirement = {
  id: number;
  created_at: string;
  client_id: string;
  doc_kind: string;
  label: string;
  note: string | null;
  status: KycRequirementStatus;
  document_id: number | null;
  requested_by: string | null;
  requested_at: string;
};

export type ClientDocument = {
  id: number;
  created_at: string;
  client_id: string;
  kind: string;
  storage_path: string;
  sha256: string | null;
  uploaded_by: string;
  size_bytes: number | null;
};

/**
 * @deprecated The legacy public-bucket URL fallback is gone — KYC documents
 * must never resolve to an unauthenticated URL. Always returns null; resolve
 * documents with getClientDocumentUrl() (60-minute signed URL via the admin
 * route). Kept only so stale imports fail soft instead of leaking a URL.
 */
export function clientDocUrl(storage_path: string): string | null {
  console.warn(
    `[client_docs] clientDocUrl("${storage_path}") is deprecated — public-bucket fallback removed; use getClientDocumentUrl()`,
  );
  return null;
}

/**
 * Admin-only: resolve a client document to a time-limited (60 min) signed URL,
 * with a public-bucket fallback for legacy rows. Returns null on failure.
 */
export async function getClientDocumentUrl(
  session: WalletSession | null | undefined,
  documentId: number,
): Promise<string | null> {
  try {
    const data = await signedFetch<{ url: string }>(
      session,
      "/api/clients/doc-url",
      "clients.doc-url",
      { document_id: documentId },
    );
    return data?.url ?? null;
  } catch (err) {
    console.warn("[client_docs] doc-url failed:", err);
    return null;
  }
}

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  let out = "";
  for (let i = 0; i < bytes.length; i += 1)
    out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

// ── Requirements ────────────────────────────────────────────────────────────

/**
 * Onboarding self-read of the client's own KYC requirements, authenticated with
 * the magic-link token (kyc_requirements has no anon SELECT). Returns [] on any
 * failure so the onboarding page degrades gracefully.
 */
export async function listRequirementsForOnboarding(
  clientId: string,
  token: string,
): Promise<KycRequirement[]> {
  if (!token) return [];
  try {
    const res = await fetch("/api/clients/onboarding-requirements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, token }),
    });
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; data?: { requirements?: KycRequirement[] } }
      | null;
    if (!res.ok || !json || json.ok !== true) return [];
    return json.data?.requirements ?? [];
  } catch (err) {
    console.warn("[kyc_req] onboarding list failed:", err);
    return [];
  }
}

export async function requestRequirements(
  session: WalletSession | null | undefined,
  clientId: string,
  items: { doc_kind: string; label: string; note?: string }[],
): Promise<{ ok: boolean; uploadLinkWarning: string | null }> {
  if (items.length === 0) return { ok: false, uploadLinkWarning: null };
  try {
    const data = await signedFetch<{
      requested: number;
      upload_link_warning?: string | null;
    }>(session, "/api/clients/request-docs", "clients.request-docs", {
      client_id: clientId,
      items,
    });
    // Set when the server could NOT include a working upload link in the
    // client's email (pre-0041 database: a fresh token has no expiry stamp and
    // the fallback TTL is already in the past for an older dossier).
    return { ok: true, uploadLinkWarning: data.upload_link_warning ?? null };
  } catch (err) {
    console.warn("[kyc_req] request failed:", err);
    return { ok: false, uploadLinkWarning: null };
  }
}

/**
 * Admin review of a submitted requirement (approve/reject). On approval the
 * server also recomputes the parent client's kyc_status: a `more_info` client
 * with no remaining open requirements flips back to `pending` — returned as
 * `recomputed` so the UI can explain the transition.
 *
 * (Replaces the pre-P1 updateRequirementStatus +
 * recomputeClientKycFromRequirements pair — both now live server-side.)
 */
export async function reviewRequirement(
  session: WalletSession | null | undefined,
  id: number,
  status: "approved" | "rejected",
): Promise<{ ok: boolean; recomputed: ClientKycStatus | null }> {
  try {
    const data = await signedFetch<{ status: string; recomputed: ClientKycStatus | null }>(
      session,
      "/api/clients/review-requirement",
      "clients.review-requirement",
      { id, status },
    );
    return { ok: true, recomputed: data?.recomputed ?? null };
  } catch (err) {
    console.warn("[kyc_req] review failed:", err);
    return { ok: false, recomputed: null };
  }
}

// ── Document uploads (private bucket, server-side) ──────────────────────────

type UploadResult = { ok: boolean; recomputed: ClientKycStatus | null };

function parseUploadResponse(
  json: { ok?: boolean; error?: string; data?: { recomputed?: string | null } } | null,
  resOk: boolean,
): UploadResult {
  if (!resOk || !json || json.ok !== true) {
    console.warn("[client_docs] upload failed:", json?.error ?? "request failed");
    return { ok: false, recomputed: null };
  }
  return {
    ok: true,
    recomputed: (json.data?.recomputed as ClientKycStatus | undefined) ?? null,
  };
}

/**
 * ADMIN upload of a KYC document into the private `client-documents` bucket.
 * `uploaded_by` is the verified signing wallet (server-side). When
 * `requirementId` is given the requirement flips to `submitted` and the
 * client's kyc_status is recomputed (returned as `recomputed`). Never throws.
 */
export async function uploadClientDocument(
  session: WalletSession | null | undefined,
  clientId: string,
  file: File,
  kind: string,
  requirementId?: number,
): Promise<UploadResult> {
  try {
    const sha = await sha256Hex(file);
    const auth = await createSignedRequest(session, "clients.upload", {
      client_id: clientId,
      kind,
      sha256: sha,
      size: file.size,
      requirement_id: requirementId ?? null,
    });
    const form = new FormData();
    form.set("auth", JSON.stringify(auth));
    form.set("file", file);
    const res = await fetch("/api/clients/upload", { method: "POST", body: form });
    const json = await res.json().catch(() => null);
    return parseUploadResponse(json, res.ok);
  } catch (e) {
    console.warn("[client_docs] upload threw:", e);
    return { ok: false, recomputed: null };
  }
}

/**
 * MAGIC-LINK upload (onboarding page): the invite token is the credential.
 * Never throws.
 */
export async function uploadClientDocumentWithToken(
  clientId: string,
  token: string,
  wallet: string,
  file: File,
  kind: string,
  requirementId?: number,
): Promise<UploadResult> {
  try {
    const form = new FormData();
    form.set("client_id", clientId);
    form.set("token", token);
    if (wallet) form.set("wallet", wallet);
    form.set("kind", kind);
    if (requirementId != null) form.set("requirement_id", String(requirementId));
    form.set("file", file);
    const res = await fetch("/api/clients/upload", { method: "POST", body: form });
    const json = await res.json().catch(() => null);
    return parseUploadResponse(json, res.ok);
  } catch (e) {
    console.warn("[client_docs] upload threw:", e);
    return { ok: false, recomputed: null };
  }
}
