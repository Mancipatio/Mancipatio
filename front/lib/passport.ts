/**
 * lib/passport.ts — on-chain investor-passport helpers.
 *
 * Wraps the asset_registry KYC instructions (approve_holder / revoke_holder /
 * create_kyc_registry) and the KycEntry account reader.
 *
 * Design: every `build*` function is pure-async and returns an instruction
 * object — no React hooks are called here.  Pages own the wallet + tx objects;
 * they call walletSigner(conn.wallet) and tx.send({ instructions: [ix], feePayer: signer }).
 *
 * Dependencies: @/lib/generated/asset_registry + @solana/kit types, plus the
 * signed /api/passport/* routes for the off-chain passport_requests intake
 * table (the table is not anon-readable — see 0031).
 */

import { type Address, type TransactionSigner } from "@solana/kit";
import type { WalletSession } from "@solana/client";
import {
  findKycRegistryPda,
  findKycEntryPda,
  getApproveHolderInstructionAsync,
  getRevokeHolderInstructionAsync,
  getCreateKycRegistryInstructionAsync,
  fetchMaybeKycEntry,
  fetchMaybeKycRegistry,
  KycStatus,
  type KycEntry,
} from "@/lib/generated/asset_registry";
import {
  fetchMaybeTransferHookConfig,
  findConfigPda,
  RestrictionMode,
} from "@/lib/generated/transfer_hook";
import { signedFetch } from "@/lib/siws-client";
import { countryName } from "@/lib/countries";

// ── Re-exports ────────────────────────────────────────────────────────────────

export { KycStatus, type KycEntry };

// ── PDA helpers ───────────────────────────────────────────────────────────────

/**
 * Derive the KycRegistry PDA for a given platform authority wallet.
 * Seeds: ["kyc_registry", authority].
 */
export async function getRegistryPda(authority: Address): Promise<Address> {
  const [pda] = await findKycRegistryPda({ authority });
  return pda;
}

/**
 * Derive the KycEntry PDA for a (registry, holder) pair.
 * Seeds: ["kyc", kycRegistry, holder].
 */
export async function getEntryPda(
  registry: Address,
  holder: Address,
): Promise<Address> {
  const [pda] = await findKycEntryPda({ kycRegistry: registry, holder });
  return pda;
}

// ── Instruction builders ──────────────────────────────────────────────────────

export type BuildIssuePassportParams = {
  /** Signer that owns the KycRegistry (platform admin wallet). */
  authoritySigner: TransactionSigner;
  /**
   * Address of the authority wallet that owns the registry.
   * Used to derive the registry PDA when it is not provided explicitly.
   * Must match authoritySigner.address.
   */
  registryAuthority: Address;
  holder: Address;
  /** ISO numeric country code (u16). */
  jurisdiction: number;
  /** 0 = retail; higher = accredited / qualified-investor tiers. */
  accreditationLevel: number;
  /** Unix timestamp (seconds) after which the entry is considered stale. */
  expiry: bigint;
  /** Off-chain KYC-provider identifier (u16). */
  providerId: number;
  /** SHA-256 hash of the off-chain KYC dossier (32 bytes). */
  externalRefHash: Uint8Array;
};

/**
 * Build an `approve_holder` instruction.
 * The generated Async builder derives kycRegistry and kycEntry PDAs
 * automatically from authority + holder.
 */
export async function buildIssuePassport(params: BuildIssuePassportParams) {
  const [kycRegistry] = await findKycRegistryPda({
    authority: params.registryAuthority,
  });

  return getApproveHolderInstructionAsync({
    authority: params.authoritySigner,
    kycRegistry,
    holder: params.holder,
    jurisdiction: params.jurisdiction,
    accreditationLevel: params.accreditationLevel,
    expiry: params.expiry,
    providerId: params.providerId,
    externalRefHash: params.externalRefHash,
  });
}

// ─────────────────────────────────────────────────────────────────────────────

export type BuildRevokePassportParams = {
  authoritySigner: TransactionSigner;
  registryAuthority: Address;
  holder: Address;
};

/**
 * Build a `revoke_holder` instruction.
 */
export async function buildRevokePassport(params: BuildRevokePassportParams) {
  const [kycRegistry] = await findKycRegistryPda({
    authority: params.registryAuthority,
  });

  return getRevokeHolderInstructionAsync({
    authority: params.authoritySigner,
    kycRegistry,
    holder: params.holder,
  });
}

// ─────────────────────────────────────────────────────────────────────────────

export type BuildCreateRegistryParams = {
  /** KYC-provider authority — pays for and OWNS the registry (its PDA seed). */
  authoritySigner: TransactionSigner;
  /**
   * Platform admin co-signer. The program requires a second signer that holds
   * an on-chain `Admin` record (the `admin_record` PDA is derived from it), so
   * registries — the root of trust of every KycGated mint — cannot be conjured
   * permissionlessly. Defaults to `authoritySigner`: on the platform registry
   * the super-admin wallet is both the provider authority and the admin, and
   * the program does not require the two keys to differ.
   */
  adminSigner?: TransactionSigner;
  /** 128-byte bitmap of approved jurisdiction codes. Use `jurisdictionBitmap`. */
  approvedJurisdictions: Uint8Array;
  /** 128-byte bitmap of blocked jurisdiction codes. Use `jurisdictionBitmap`. */
  blockedJurisdictions: Uint8Array;
};

/**
 * Build a `create_kyc_registry` instruction.
 * The kycRegistry PDA is derived automatically from authoritySigner.address,
 * the admin_record PDA from the admin co-signer.
 *
 * NOTE: the admin co-signer + admin_record accounts were added to the program
 * in the receiver-KYC hardening wave; this builder therefore requires the
 * MATCHING program build to be deployed (the account list is positional).
 */
export async function buildCreateRegistry(params: BuildCreateRegistryParams) {
  return getCreateKycRegistryInstructionAsync({
    authority: params.authoritySigner,
    adminAuthority: params.adminSigner ?? params.authoritySigner,
    approvedJurisdictions: params.approvedJurisdictions,
    blockedJurisdictions: params.blockedJurisdictions,
  });
}

// ── Account fetch ─────────────────────────────────────────────────────────────

/**
 * Fetch and decode the KycEntry for (registry, holder).
 * Returns the decoded account data or null when the account does not exist.
 *
 * rpc — the Solana RPC client from useSolanaClient().runtime.rpc
 */
export async function fetchPassport(
  rpc: Parameters<typeof fetchMaybeKycEntry>[0],
  registry: Address,
  holder: Address,
): Promise<KycEntry | null> {
  const [entryPda] = await findKycEntryPda({ kycRegistry: registry, holder });
  const maybe = await fetchMaybeKycEntry(rpc, entryPda);
  return maybe.exists ? maybe.data : null;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * SHA-256 hash of a canonical string, returning a 32-byte Uint8Array.
 * Use this to produce `externalRefHash` from a stable off-chain dossier ID.
 */
export async function dossierHash(canonical: string): Promise<Uint8Array> {
  const encoded = new TextEncoder().encode(canonical);
  const hashBuf = await crypto.subtle.digest("SHA-256", encoded);
  return new Uint8Array(hashBuf);
}

/**
 * Size in bytes of every on-chain jurisdiction bitmap — mirrors
 * `asset_registry::state::JURISDICTION_BITMAP_BYTES`. 128 bytes = 1024 bits
 * covers the whole ISO-3166-1 numeric range (000–899 assigned, 900–999
 * user-assigned); the pre-2026-08-10 maps were 32 bytes and could not encode
 * most of the world (Germany 276, Serbia 688, Spain 724, UK 826 …).
 */
export const JURISDICTION_BITMAP_BYTES = 128;

/**
 * Build a 128-byte jurisdiction bitmap from an array of ISO numeric country
 * codes.  Each code sets bit (code % 8) of byte (code >> 3). Codes outside
 * the bitmap (≥ 1024 — no such ISO code exists) are dropped, exactly as the
 * chain would reject them; use isJurisdictionRepresentable() to detect that
 * before issuing a passport.
 */
export function jurisdictionBitmap(codes: number[]): Uint8Array {
  const bitmap = new Uint8Array(JURISDICTION_BITMAP_BYTES);
  for (const code of codes) {
    const byte = code >> 3;      // Math.floor(code / 8)
    const bit = code & 0x7;     // code % 8
    if (byte < JURISDICTION_BITMAP_BYTES) {
      bitmap[byte] |= 1 << bit;
    }
  }
  return bitmap;
}

/**
 * True when the ISO numeric code fits in the on-chain 128-byte (1024-bit)
 * registry bitmap. Every assigned ISO-3166-1 numeric code (≤ 999) now fits;
 * only a malformed code ≥ 1024 would fail the program's byte-bound check
 * (ReceiverJurisdictionBlocked, fail-closed).
 */
export function isJurisdictionRepresentable(code: number): boolean {
  return (
    Number.isInteger(code) && code >= 0 && code < JURISDICTION_BITMAP_BYTES * 8
  );
}

/**
 * Mirror of the on-chain jurisdiction check (util.rs): bit (code % 8) of byte
 * (code / 8) must be set AND the byte index must be < JURISDICTION_BITMAP_BYTES.
 * Accepts any byte-indexable bitmap (Uint8Array, the generated
 * ReadonlyUint8Array, or a plain number array).
 */
export function bitmapHasCode(bitmap: ArrayLike<number>, code: number): boolean {
  if (!isJurisdictionRepresentable(code)) return false;
  const byte = code >> 3;
  const bit = code & 0x7;
  return byte < bitmap.length && (bitmap[byte] & (1 << bit)) !== 0;
}

/**
 * Chain-accurate passport expiry semantics: a KycEntry is valid only while
 * `expiry > now` (unix seconds). expiry == 0 therefore means ALWAYS expired —
 * never "no expiry". Mirrors `entry.expiry > Clock::get()?.unix_timestamp`
 * in the program.
 */
export function isPassportExpired(
  expiry: bigint | number,
  nowSec: number,
): boolean {
  return Number(expiry) <= nowSec;
}

// ── Receiver-eligibility pre-check ────────────────────────────────────────────

export type ReceiverEligibility = {
  /** True when the mint's hook config says `KycGated`. */
  gated: boolean;
  /** True when a delivery to `receiver` would pass the on-chain gate. */
  ok: boolean;
  /** Human-readable reason when `ok` is false (empty otherwise). */
  reason: string;
};

/**
 * Client-side mirror of the program's `receiver_kyc_outcome` (util.rs) for ONE
 * (mint, receiver) pair — the gate every escrow→wallet DELIVERY of share units
 * has to pass (`take_offer`, `settle_otc_deal`, an above-ledger custody
 * return, `buy`).
 *
 * It checks the same four things, in the same order:
 *   1. the mint's `TransferHookConfig` — absent or `Open` ⇒ not gated;
 *   2. the receiver's `KycEntry` exists and is `Approved`;
 *   3. `expiry > now` (expiry == 0 is ALWAYS expired — see isPassportExpired);
 *   4. the entry's jurisdiction bit set in the registry's approved bitmap and
 *      clear in the blocked one.
 *
 * FAIL-CLOSED: any RPC or decode failure returns `{ gated: true, ok: false }`.
 * This is a pre-flight courtesy only — the chain re-checks everything.
 */
export async function checkReceiverEligibility(
  rpc: Parameters<typeof fetchMaybeKycEntry>[0],
  mint: Address,
  receiver: Address,
): Promise<ReceiverEligibility> {
  try {
    const [configPda] = await findConfigPda({ mint });
    const cfg = await fetchMaybeTransferHookConfig(rpc, configPda);
    if (!cfg.exists || cfg.data.restrictionMode !== RestrictionMode.KycGated) {
      return { gated: false, ok: true, reason: "" };
    }
    const registryOpt = cfg.data.kycRegistry;
    const registry =
      registryOpt.__option === "Some" ? registryOpt.value : null;
    if (!registry) {
      // The program guarantees a registry whenever the mode is KycGated, so
      // this is a malformed config — refuse rather than wave it through.
      return {
        gated: true,
        ok: false,
        reason: `Mint ${mint} is KYC-gated but its hook config names no KYC registry.`,
      };
    }
    const [entry, maybeRegistry] = await Promise.all([
      fetchPassport(rpc, registry, receiver),
      fetchMaybeKycRegistry(rpc, registry),
    ]);
    if (!entry) {
      return {
        gated: true,
        ok: false,
        reason: `${receiver} has no investor passport on registry ${registry}.`,
      };
    }
    if (entry.status !== KycStatus.Approved) {
      return {
        gated: true,
        ok: false,
        reason: `${receiver}'s investor passport is not approved (status ${entry.status}).`,
      };
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (isPassportExpired(entry.expiry, nowSec)) {
      return {
        gated: true,
        ok: false,
        reason: `${receiver}'s investor passport has expired.`,
      };
    }
    if (!maybeRegistry.exists) {
      return {
        gated: true,
        ok: false,
        reason: `KYC registry ${registry} could not be read.`,
      };
    }
    const jurisdictionOk =
      bitmapHasCode(maybeRegistry.data.approvedJurisdictions, entry.jurisdiction) &&
      !bitmapHasCode(maybeRegistry.data.blockedJurisdictions, entry.jurisdiction);
    if (!jurisdictionOk) {
      return {
        gated: true,
        ok: false,
        // COUNTRIES codes are zero-padded 3-digit ISO numeric strings.
        reason: `${receiver}'s jurisdiction (${countryName(
          String(entry.jurisdiction).padStart(3, "0"),
        )}) is not approved on registry ${registry}.`,
      };
    }
    return { gated: true, ok: true, reason: "" };
  } catch (err) {
    return {
      gated: true,
      ok: false,
      reason: `Could not verify the receiver's investor passport: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/**
 * Default approved-jurisdiction set (ISO numeric codes) — single source for
 * the /admin/kyc registry bootstrap AND the /api/passport/submit validation.
 *
 * Every code here is fully representable in the on-chain 128-byte bitmap
 * (widened 2026-08-10 — until then codes ≥ 256, Serbia 688 included, could
 * not be encoded and on-chain issuance for them was an explicit blocker).
 */
export const DEFAULT_APPROVED_JURISDICTIONS: readonly number[] = [
  40, // Austria
  56, // Belgium
  100, // Bulgaria
  191, // Croatia
  196, // Cyprus
  203, // Czechia
  208, // Denmark
  233, // Estonia
  246, // Finland
  250, // France
  276, // Germany
  300, // Greece
  348, // Hungary
  372, // Ireland
  380, // Italy
  428, // Latvia
  440, // Lithuania
  442, // Luxembourg
  470, // Malta
  528, // Netherlands
  616, // Poland
  620, // Portugal
  642, // Romania
  703, // Slovakia
  705, // Slovenia
  724, // Spain
  752, // Sweden
  578, // Norway
  756, // Switzerland
  438, // Liechtenstein
  356, // India
  36, // Australia
  124, // Canada
  392, // Japan
  410, // South Korea
  688, // Serbia (platform home market)
  702, // Singapore
  784, // UAE
  826, // United Kingdom
];

/** True when the code is in the platform's default approved set. */
export function isDefaultApprovedJurisdiction(code: number): boolean {
  return DEFAULT_APPROVED_JURISDICTIONS.includes(code);
}

// ── Issue gate (shared by /admin/kyc and /admin/clients/[id]) ────────────────

/** Minimal dossier shape the issue gate needs. */
export type IssueGateClient = {
  kyc_status: string;
  kyc_expires_at?: string | null;
};

export type IssueGateInput = {
  /** Linked off-chain dossier; null/undefined = no dossier found. */
  client: IssueGateClient | null | undefined;
  /** ISO numeric jurisdiction that would be written on-chain (null = none). */
  jurisdiction: number | null | undefined;
  /**
   * On-chain KycRegistry bitmaps; null/undefined = could not load — the
   * bitmap checks are skipped (the chain still enforces them on transfer).
   */
  registry?: {
    approvedJurisdictions: ArrayLike<number>;
    blockedJurisdictions: ArrayLike<number>;
  } | null;
  /** Wallet is on the on-chain sanctions blocklist; null = unknown. */
  walletBlocked?: boolean | null;
  /** There is an OPEN compliance alert for the wallet; null = unknown. */
  hasOpenAlert?: boolean | null;
  /** Clock override (ms) for tests. */
  nowMs?: number;
};

/**
 * The SINGLE issue gate: every reason why approve_holder must NOT be sent.
 * Empty array = safe to issue. BOTH issuance paths (/admin/kyc request queue
 * and /admin/clients/[id] dossier page) MUST run this before
 * buildIssuePassport — a second path that skips it re-creates the
 * "jurisdiction 0 passport" bug this gate exists to prevent.
 *
 * Semantics:
 *   * no dossier / dossier not `verified`      → fail-closed
 *   * `verified` but kyc_expires_at in the past → fail-closed (issuing would
 *     silently extend an expired verification by the policy default)
 *   * unparseable kyc_expires_at               → fail-closed
 *   * registry / blocklist / alerts unknown    → those checks are skipped
 *     (fail-open with the caller expected to log) — the chain re-enforces the
 *     bitmap and blocklist on every transfer.
 */
export function issueBlockers(input: IssueGateInput): string[] {
  const blockers: string[] = [];
  const now = input.nowMs ?? Date.now();
  const client = input.client ?? null;

  if (!client) {
    blockers.push(
      "No client dossier is linked to this wallet — provision one first (new self-service applications auto-provision it).",
    );
  } else if (client.kyc_status !== "verified") {
    blockers.push(
      `Client KYC is "${client.kyc_status}" — review the dossier and approve KYC first.`,
    );
  } else if (client.kyc_expires_at) {
    const expMs = Date.parse(client.kyc_expires_at);
    if (!Number.isFinite(expMs) || expMs <= now) {
      blockers.push(
        "The off-chain KYC verification has expired — re-verify the dossier before issuing (issuing now would silently extend an expired verification).",
      );
    }
  }

  const code = input.jurisdiction;
  if (code == null || !Number.isInteger(code) || code <= 0) {
    blockers.push(
      "No jurisdiction on record — a passport without one is unusable (every on-chain check rejects jurisdiction 0).",
    );
  } else {
    const name = countryName(String(code).padStart(3, "0"));
    if (!isJurisdictionRepresentable(code)) {
      blockers.push(
        `${name} (code ${code} ≥ 1024) cannot be represented in the on-chain 128-byte registry bitmap — every gated transfer would fail with ReceiverJurisdictionBlocked.`,
      );
    } else if (input.registry) {
      if (!bitmapHasCode(input.registry.approvedJurisdictions, code)) {
        blockers.push(
          `${name} is not in the registry's approved bitmap — gated transfers would fail.`,
        );
      }
      if (bitmapHasCode(input.registry.blockedJurisdictions, code)) {
        blockers.push(`${name} is in the registry's BLOCKED bitmap.`);
      }
    }
  }

  if (input.walletBlocked === true) {
    blockers.push("This wallet is on the on-chain sanctions blocklist.");
  }
  if (input.hasOpenAlert === true) {
    blockers.push(
      "There is an OPEN compliance alert for this wallet — resolve it first.",
    );
  }
  return blockers;
}

// ── Passport requests (off-chain intake, Supabase) ────────────────────────────
//
// Investors without a KycEntry apply from /portfolio; admins triage the queue
// on /admin/kyc and issue the on-chain passport from a request row.
// Table: passport_requests (migration 0028).

export type PassportRequestStatus = "new" | "in_review" | "approved" | "rejected";

export type PassportRequest = {
  id: string;
  created_at: string;
  wallet: string;
  registry_pda: string | null;
  /** ISO-3166-1 numeric country code (self-declared by the applicant). */
  jurisdiction: number | null;
  note: string | null;
  status: PassportRequestStatus;
  handled_by: string | null;
  handled_at: string | null;
};

export type PassportRequestInput = {
  wallet: string;
  /** Platform KYC registry PDA the applicant was checked against, if known. */
  registryPda?: string;
  /** ISO-3166-1 numeric country code. */
  jurisdiction?: number;
  note?: string;
};

export type PassportSubmitResult = {
  /** passport_requests row id. */
  id: string;
  /** Linked/auto-provisioned clients row id (KYC dossier). */
  clientId: string | null;
  /**
   * Relative onboarding magic-link path (/onboarding/{id}?t=…) where the
   * applicant uploads the requested KYC documents. Null when the linked
   * client needs no documents (already verified) — or when the server could
   * not issue a link it would itself accept (see `onboardingNotice`).
   */
  onboardingPath: string | null;
  /**
   * Server explanation to show INSTEAD of a link when `onboardingPath` is
   * null for a reason the applicant should hear about (today: migration 0041
   * missing, so a fresh token gets no expiry stamp and would 401 at once).
   */
  onboardingNotice: string | null;
};

/**
 * Submit an investor passport request via the signed route
 * (POST /api/passport/submit). The server writes the row for the VERIFIED
 * signer wallet — `input.wallet` must match the connected session wallet —
 * and auto-provisions (or links) the off-chain KYC dossier, returning the
 * onboarding path for document upload. THROWS on failure (dedupe 409, rate
 * limit 429, validation 400) so the modal can show the server's message.
 */
export async function submitPassportRequest(
  session: WalletSession | null | undefined,
  input: PassportRequestInput,
): Promise<PassportSubmitResult> {
  const data = await signedFetch<{
    id: string;
    client_id: string | null;
    onboarding_path: string | null;
    onboarding_notice?: string | null;
  }>(session, "/api/passport/submit", "passport.submit", {
    wallet: input.wallet,
    registry_pda: input.registryPda,
    jurisdiction: input.jurisdiction,
    note: input.note,
  });
  return {
    id: data.id,
    clientId: data.client_id ?? null,
    onboardingPath: data.onboarding_path ?? null,
    onboardingNotice: data.onboarding_notice ?? null,
  };
}

/**
 * List all passport requests, newest first (admin queue) via the signed
 * admin route (POST /api/passport/list). The table is no longer
 * anon-readable — it deanonymizes the KYC pipeline — so the read requires a
 * connected admin wallet. Best-effort: returns [] on failure (unchanged
 * caller contract).
 */
export async function listPassportRequests(
  session: WalletSession | null | undefined,
): Promise<PassportRequest[]> {
  try {
    const data = await signedFetch<{ requests: PassportRequest[] }>(
      session,
      "/api/passport/list",
      "passport.list",
      {},
    );
    return data.requests ?? [];
  } catch (err) {
    console.warn(
      "[passport] request list failed:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/** Minimal shape the unsigned status probe exposes (no jurisdiction/note). */
export type OpenPassportRequest = Pick<
  PassportRequest,
  "id" | "status" | "created_at"
>;

/**
 * The wallet's newest UNDECIDED (new / in_review) passport request, or null
 * (portfolio card). Reads the unsigned minimal /api/passport/status route —
 * the anon-key table read is gone, and a signature prompt on every
 * /portfolio load would be hostile, so the server exposes only
 * id/status/created_at for the open request.
 */
export async function getOpenPassportRequest(
  wallet: string,
): Promise<OpenPassportRequest | null> {
  try {
    const res = await fetch("/api/passport/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet }),
    });
    const json = (await res.json()) as {
      ok?: boolean;
      data?: { open: OpenPassportRequest | null };
      error?: string;
    };
    if (!res.ok || json.ok !== true || !json.data) {
      console.warn(
        "[passport] status probe failed:",
        json?.error ?? res.status,
      );
      return null;
    }
    return json.data.open;
  } catch (err) {
    console.warn("[passport] status probe threw:", err);
    return null;
  }
}

/**
 * Admin triage/decision update (status, handled_by, handled_at) via the
 * signed admin route (POST /api/passport/update). The server FORCES
 * handled_by to the verified signer wallet whenever the key is present.
 * `reason` (optional, decisions only) is written to the linked client's
 * timeline and included in the applicant's decision email server-side.
 */
export async function updatePassportRequest(
  session: WalletSession | null | undefined,
  id: string,
  patch: Partial<Pick<PassportRequest, "status" | "handled_by" | "handled_at">>,
  reason?: string,
): Promise<boolean> {
  try {
    await signedFetch(session, "/api/passport/update", "passport.update", {
      id,
      patch,
      reason: reason ?? null,
    });
    return true;
  } catch (err) {
    console.warn(
      "[passport] request update failed:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
