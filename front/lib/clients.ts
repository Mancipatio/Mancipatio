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
// service-role client server-side; admins read them through 2-minute signed
// URLs (getClientDocumentUrl), and every such view is audit-logged server-side
// before the URL is returned. Legacy pre-P1 files still in the public
// "documents" bucket are NOT served (no public fallback) until moved.

import type { WalletSession } from "@solana/client";
import {
  signedFetch,
  createSignedRequest,
} from "@/lib/siws-client";
import { TOS_VERSION } from "@/lib/tos-version";
import { MAINTENANCE_CODE, maintenanceRefusal } from "@/lib/maintenance";
import { detectNetwork } from "@/lib/network";
import type { AnonymizeResult } from "@/lib/client-privacy";
import type { ClientReviewReason } from "@/lib/admin-badge-rules";
import { notifyAdminBadges } from "@/lib/admin-badges-events";
import { UPLOAD_MIME_ALLOWLIST, uploadContentType } from "@/lib/storage-client";

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
  /** When the dossier's personal data was last erased (0065); null = never. */
  anonymized_at?: string | null;
  /**
   * Why the dossier waits for a reviewer ([] = it does not), from the reader
   * of the /admin/clients menu badge. admin-list only, and absent when the
   * server could not read it.
   */
  review_reasons?: ClientReviewReason[];
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
 * The directory with each row's `review_reasons`, and whether they could be
 * read — the /admin/clients "Needs review" tab, which reproduces the menu
 * badge. THROWS.
 */
export async function listClientDirectory(
  session: WalletSession | null | undefined,
): Promise<{ clients: ClientRow[]; reviewAvailable: boolean }> {
  const data = await signedFetch<{ clients: ClientRow[]; review_available?: boolean }>(
    session,
    "/api/clients/admin-list",
    "clients.adminList",
    { review: true },
  );
  return { clients: data.clients ?? [], reviewAvailable: data.review_available === true };
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
  status: "pending" | "verified" | "rejected";
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_note: string | null;
};

/** Admin: approve / reject / reopen a company verification (KYB). */
export async function adminDecideKyb(
  session: WalletSession | null | undefined,
  clientId: string,
  decision: "verified" | "rejected" | "pending",
  note?: string,
): Promise<void> {
  await signedFetch(session, "/api/clients/kyb-decision", "clients.kybDecision", {
    client_id: clientId, decision, ...(note ? { note } : {}),
  });
  notifyAdminBadges();
}

export type ClientDetail = {
  client: ClientRow;
  notes: ClientNote[];
  requirements: KycRequirement[];
  documents: ClientDocument[];
  verification?: ClientVerificationDetails[];
  raise_limits?: ClientRaiseLimits | null;
  raise_capacity?: { year: number; cap: number; used: number; remaining: number; max_equity_percent: number; cap_source: "platform" | "client" } | null;
};

/** Per-client ("case by case") override of the raise limits (0056). */
export type ClientRaiseLimits = {
  client_id: string;
  annual_raise_cap_eur: number | null;
  max_equity_percent: number | null;
  note: string | null;
  updated_at: string;
  updated_by: string | null;
};

/** Admin: set (or clear) a client's raise-limit override. */
export async function adminSetClientRaiseLimits(
  session: WalletSession | null | undefined,
  clientId: string,
  input: { annual_raise_cap_eur: number | null; max_equity_percent: number | null; note?: string } | { clear: true },
): Promise<void> {
  await signedFetch(session, "/api/clients/raise-limits", "clients.raiseLimits", { client_id: clientId, ...input });
}

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
 * Admin (GDPR access / portability): the JSON bundle of everything stored
 * about one dossier, with short-lived document links. Needs a fresh wallet
 * signature; the server logs the export before answering. THROWS.
 */
export async function adminExportClient(
  session: WalletSession | null | undefined,
  clientId: string,
): Promise<Record<string, unknown>> {
  return await signedFetch<Record<string, unknown>>(
    session,
    "/api/clients/export",
    "clients.export",
    { client_id: clientId },
  );
}

/**
 * Super Admin (GDPR erasure): erase the dossier's personal data. `confirm`
 * must be anonymizeConfirmationPhrase(clientId). Not reversible. THROWS.
 */
export async function adminAnonymizeClient(
  session: WalletSession | null | undefined,
  clientId: string,
  confirm: string,
  reason: string,
): Promise<AnonymizeResult> {
  const result = await signedFetch<AnonymizeResult>(
    session,
    "/api/clients/anonymize",
    "clients.anonymize",
    { client_id: clientId, confirm, reason },
  );
  // An erased dossier leaves the review queue.
  notifyAdminBadges();
  return result;
}

/**
 * The onboarding page's view of its own dossier (/api/clients/onboarding-view):
 * a fixed projection — never the onboarding token, nor the dossier's internal
 * columns (tags, tier, source, provider references, account id, notes).
 */
export type OnboardingView = Pick<
  ClientRow,
  | "id"
  | "type"
  | "display_name"
  | "kyc_status"
  | "onboarding_status"
  | "wallet"
  | "tos_accepted_at"
  | "tos_version"
> & {
  /**
   * True for a dossier owned by a wallet-less (email/Google) account: the
   * Terms and the document uploads need no wallet, and linking one is
   * optional (server mirror: isAccountOwnedDossier in app/api/clients/_helpers.ts).
   */
  account_owned: boolean;
};

/**
 * One row of the onboarding checklist (/api/clients/onboarding-requirements):
 * what the page renders, never who requested the document.
 */
export type OnboardingRequirement = Pick<
  KycRequirement,
  "id" | "doc_kind" | "label" | "note" | "status" | "requested_at"
>;

/**
 * Token-authed onboarding read: validates the magic-link token SERVER-SIDE and
 * returns the dossier's onboarding projection, WITHOUT onboarding_token (the
 * browser must never read that bearer secret — W3-RLS revokes the column from
 * the anon role) and without the internal columns. Used by the onboarding
 * page in place of getClient + a client-side token compare.
 * Returns { client: null, tokenValid: false } for a missing/invalid token.
 */
export async function getClientForOnboarding(
  clientId: string,
  token: string,
): Promise<{ client: OnboardingView | null; tokenValid: boolean }> {
  if (!token) return { client: null, tokenValid: false };
  try {
    const res = await fetch("/api/clients/onboarding-view", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, token }),
    });
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; data?: OnboardingView; error?: string }
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
    notifyAdminBadges();
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
  notifyAdminBadges();
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
    // An issued passport also closes the wallet's passport request (/admin/kyc).
    notifyAdminBadges();
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
      | { ok?: boolean; error?: string; code?: string; message?: string }
      | null;
    // Maintenance: show the banner, so the failed step explains itself.
    if (json?.code === MAINTENANCE_CODE) maintenanceRefusal(json.message, detectNetwork());
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

// ── Onboarding page gates (pure; unit-tested in tests/onboarding-page.test.ts) ──

/** What the onboarding page knows when it decides which step to show. */
export type OnboardingGateInput = {
  /** The dossier belongs to a wallet-less (email/Google) account (OnboardingView.account_owned). */
  accountOwned: boolean;
  /** A wallet is connected in the browser. */
  walletConnected: boolean;
  /** The dossier already carries a wallet (onboarding past `invited`). */
  alreadyConnected: boolean;
  /** This session just linked the connected wallet. */
  linked: boolean;
  /** The connected wallet is the dossier's wallet. */
  sameWallet: boolean;
  /** The dossier has accepted the current Terms. */
  tosAccepted: boolean;
};

export type OnboardingGates = {
  /** Step 1, the connect prompt: a wallet is required before anything else. */
  showConnect: boolean;
  /** The Terms card. */
  showTerms: boolean;
  /** The standalone Accept button in the Terms card (otherwise acceptance rides on the link step). */
  showTermsAccept: boolean;
  /** The link card for the connected wallet. */
  showLink: boolean;
  /** The link is optional: the page says so, and nothing waits for it. */
  linkOptional: boolean;
  /** A wallet other than the dossier's is connected. */
  showWrongWallet: boolean;
  /** The "Next steps" card. */
  showNext: boolean;
  /** Document uploads are open (the page still asks each requirement for an open status). */
  uploadsOpen: boolean;
};

/**
 * Which onboarding steps the page shows. A dossier owned by a wallet-less
 * account needs no wallet: the Terms first, then the documents, and a wallet
 * may be linked at any time (the server side: accept-tos and upload accept
 * its token alone). A wallet dossier keeps the wallet path: connect, accept
 * the Terms, link, then upload.
 */
export function onboardingGates(input: OnboardingGateInput): OnboardingGates {
  const { accountOwned, walletConnected, alreadyConnected, linked, sameWallet, tosAccepted } = input;
  if (accountOwned) {
    return {
      showConnect: false,
      showTerms: true,
      showTermsAccept: !tosAccepted,
      showLink: walletConnected && !linked,
      linkOptional: true,
      showWrongWallet: false,
      showNext: tosAccepted,
      uploadsOpen: tosAccepted,
    };
  }
  return {
    showConnect: !walletConnected,
    showTerms: walletConnected,
    // Already-linked clients (pre-ToS-gate) accept in place.
    showTermsAccept: !tosAccepted && alreadyConnected && sameWallet,
    showLink: walletConnected && !alreadyConnected && !linked,
    linkOptional: false,
    showWrongWallet: walletConnected && alreadyConnected && !sameWallet,
    showNext: (alreadyConnected || linked) && sameWallet,
    uploadsOpen: walletConnected && (alreadyConnected || linked),
  };
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
 * documents with getClientDocumentUrl() (short-lived, logged signed URL via
 * the admin route). Kept only so stale imports fail soft instead of leaking a
 * URL.
 */
export function clientDocUrl(storage_path: string): string | null {
  console.warn(
    `[client_docs] clientDocUrl("${storage_path}") is deprecated — public-bucket fallback removed; use getClientDocumentUrl()`,
  );
  return null;
}

/**
 * Admin-only: resolve a client document to a short-lived (2 min) signed URL.
 * The server logs the view (audit_events, category "kyc") before answering;
 * when the log is unavailable it refuses with 503 and no URL. THROWS on
 * failure so the caller can show the server's reason.
 */
export async function getClientDocumentUrl(
  session: WalletSession | null | undefined,
  documentId: number,
): Promise<string> {
  const data = await signedFetch<{ url: string }>(
    session,
    "/api/clients/doc-url",
    "clients.doc-url",
    { document_id: documentId },
  );
  if (!data?.url) throw new Error("Could not resolve the document URL");
  return data.url;
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
): Promise<OnboardingRequirement[]> {
  if (!token) return [];
  try {
    const res = await fetch("/api/clients/onboarding-requirements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, token }),
    });
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; data?: { requirements?: OnboardingRequirement[] } }
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
    notifyAdminBadges();
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
  /** Rejections only: why, emailed to the client with the replacement request. */
  reason?: string,
): Promise<{
  ok: boolean;
  recomputed: ClientKycStatus | null;
  notified: boolean;
  /** Why no email went out (rejections only): the dossier had no review in progress, no address, or the send failed. */
  notNotified: "no_review_in_progress" | "no_email_on_file" | "email_failed" | null;
}> {
  try {
    const data = await signedFetch<{
      status: string;
      recomputed: ClientKycStatus | null;
      notified?: boolean;
      not_notified?: "no_review_in_progress" | "no_email_on_file" | "email_failed" | null;
    }>(
      session,
      "/api/clients/review-requirement",
      "clients.review-requirement",
      status === "rejected" && reason?.trim() ? { id, status, reason: reason.trim() } : { id, status },
    );
    notifyAdminBadges();
    return {
      ok: true,
      recomputed: data?.recomputed ?? null,
      notified: data?.notified === true,
      notNotified: data?.not_notified ?? null,
    };
  } catch (err) {
    console.warn("[kyc_req] review failed:", err);
    return { ok: false, recomputed: null, notified: false, notNotified: null };
  }
}

// ── Document uploads (private bucket, server-side) ──────────────────────────

/**
 * Size cap for a KYC document sent through /api/clients/upload. The route
 * allows 15 MiB (MAX_UPLOAD_BYTES in app/api/clients/_helpers.ts), but the
 * file travels in the request body of a serverless function, and Vercel
 * answers 413 for bodies over 4.5 MB before the route runs — so 4 MiB is the
 * limit a user can actually reach. Not storage-client's 25 MB: that flow
 * uploads straight to Storage.
 */
export const KYC_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

/**
 * `accept` for the KYC file pickers: the route's allowlist (PDF, PNG, JPEG,
 * DOCX — app/api/clients/upload/route.ts ALLOWED_MIME and migration 0077;
 * UPLOAD_MIME_ALLOWLIST in lib/storage-client.ts carries the same four).
 */
export const KYC_UPLOAD_ACCEPT = `.pdf,.png,.jpg,.jpeg,.docx,${UPLOAD_MIME_ALLOWLIST.join(",")}`;

/** Same wording as the route's refusal. */
const KYC_UPLOAD_TYPE_MESSAGE = "Unsupported file type — upload a PDF, PNG, JPG or DOCX";
const KYC_UPLOAD_SIZE_MESSAGE =
  "The file is larger than 4 MB. Scan or photograph it at a lower resolution, or save it as a smaller PDF.";

/**
 * Why the upload route would refuse `file`, before it is sent (or, for an
 * operator, signed): empty, too large for the request body, or a type outside
 * the allowlist. Null when the file is fine. An empty `File.type` (some
 * browsers report none for .docx) is resolved from the extension, as
 * withUploadType declares it.
 */
export function kycUploadProblem(file: File): string | null {
  if (file.size === 0) return "The file is empty.";
  if (file.size > KYC_UPLOAD_MAX_BYTES) return KYC_UPLOAD_SIZE_MESSAGE;
  if (!(UPLOAD_MIME_ALLOWLIST as readonly string[]).includes(uploadContentType(file))) {
    return KYC_UPLOAD_TYPE_MESSAGE;
  }
  return null;
}

/**
 * `file` with its type declared when the browser reported none: the route
 * reads an empty type as octet-stream and refuses it. Same bytes, so a signed
 * sha256 and size still match.
 */
export function withUploadType(file: File): File {
  if (file.type) return file;
  return new File([file], file.name, { type: uploadContentType(file), lastModified: file.lastModified });
}

/** The message shown for a failed upload: the server's reason when it gave one. */
export function uploadFailureMessage(status: number, serverError: unknown): string {
  // The platform refused the body before the route ran (FUNCTION_PAYLOAD_TOO_LARGE).
  if (status === 413) return KYC_UPLOAD_SIZE_MESSAGE;
  if (typeof serverError === "string" && serverError.trim()) return serverError;
  if (status === 429) return "Too many uploads — wait a minute and try again.";
  return `Could not upload the document (HTTP ${status}). Please try again.`;
}

const UPLOAD_NETWORK_ERROR = "Network error — check your connection and try again.";

/**
 * `error` is the failure worded for users: the server's reason (an expired
 * link, a refused type, a locked dossier), the maintenance notice, a local
 * check that spared the request, or the network.
 */
type UploadResult = { ok: boolean; recomputed: ClientKycStatus | null; error?: string };

function parseUploadResponse(
  json: { ok?: boolean; error?: string; code?: string; message?: string; data?: { recomputed?: string | null } } | null,
  res: { ok: boolean; status: number },
): UploadResult {
  if (json?.code === MAINTENANCE_CODE) {
    return { ok: false, recomputed: null, error: maintenanceRefusal(json.message, detectNetwork()).message };
  }
  if (!res.ok || !json || json.ok !== true) {
    const error = uploadFailureMessage(res.status, json?.error);
    console.warn("[client_docs] upload failed:", error);
    return { ok: false, recomputed: null, error };
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
 * client's kyc_status is recomputed (returned as `recomputed`). A file the
 * route would refuse is reported before the signature prompt. Never throws.
 */
export async function uploadClientDocument(
  session: WalletSession | null | undefined,
  clientId: string,
  file: File,
  kind: string,
  requirementId?: number,
): Promise<UploadResult> {
  const problem = kycUploadProblem(file);
  if (problem) return { ok: false, recomputed: null, error: problem };
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
    form.set("file", withUploadType(file));
    const res = await fetch("/api/clients/upload", { method: "POST", body: form });
    const json = await res.json().catch(() => null);
    const result = parseUploadResponse(json, res);
    if (result.ok) notifyAdminBadges();
    return result;
  } catch (e) {
    console.warn("[client_docs] upload threw:", e);
    return { ok: false, recomputed: null, error: e instanceof Error && e.message ? e.message : UPLOAD_NETWORK_ERROR };
  }
}

/**
 * MAGIC-LINK upload (onboarding page): the invite token is the credential.
 * `wallet` is informational only — the route stamps `uploaded_by` from the
 * validated dossier (its wallet, or "client" for an account-owned dossier).
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
  const problem = kycUploadProblem(file);
  if (problem) return { ok: false, recomputed: null, error: problem };
  try {
    const form = new FormData();
    form.set("client_id", clientId);
    form.set("token", token);
    if (wallet) form.set("wallet", wallet);
    form.set("kind", kind);
    if (requirementId != null) form.set("requirement_id", String(requirementId));
    form.set("file", withUploadType(file));
    const res = await fetch("/api/clients/upload", { method: "POST", body: form });
    const json = await res.json().catch(() => null);
    return parseUploadResponse(json, res);
  } catch (e) {
    console.warn("[client_docs] upload threw:", e);
    return { ok: false, recomputed: null, error: UPLOAD_NETWORK_ERROR };
  }
}
