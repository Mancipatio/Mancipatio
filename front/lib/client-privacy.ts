// Client privacy (GDPR) — literals shared by the admin page and the routes
// /api/clients/export and /api/clients/anonymize. No browser or server-only
// imports, so both halves can use it.

/** Version tag of the export bundle's shape. Bump when fields change meaning. */
export const CLIENT_EXPORT_FORMAT = "manci.client-data-export.v1";

/**
 * The phrase a Super Admin must type to anonymize a dossier. It names the
 * dossier (first 8 characters of its id) so a confirmation typed for one
 * client can never erase another.
 */
export function anonymizeConfirmationPhrase(clientId: string): string {
  return `ANONYMIZE ${clientId.slice(0, 8).toLowerCase()}`;
}

/** True when `typed` is exactly the phrase for `clientId` (surrounding spaces ignored). */
export function isAnonymizeConfirmation(clientId: string, typed: unknown): boolean {
  return typeof typed === "string" && typed.trim() === anonymizeConfirmationPhrase(clientId);
}

/** Counts reported by anonymize_client() (migration 0065). */
export type AnonymizeCounts = {
  documents: number;
  verification_details: number;
  notes_erased: number;
  requirements_cleared: number;
  tos_detached: number;
  passport_request_notes: number;
};

/** What /api/clients/anonymize reports back. */
export type AnonymizeResult = {
  anonymized_at: string;
  counts: AnonymizeCounts;
  /** Files deleted from storage (both buckets, including late uploads). */
  files_deleted: number;
  /** Of those, pre-P1 files deleted from the old public `documents` bucket. */
  legacy_files_deleted: number;
  /** Document rows whose file was in neither bucket (already gone). */
  files_missing: number;
  /** Files kept because another dossier's document row points at them too. */
  files_shared: number;
  /** Files uploaded during the erasure that could not be deleted — run again. */
  files_left: number;
  /** False when the post-erasure check for raced uploads failed — run again. */
  late_sweep_complete: boolean;
  /**
   * Public-bucket paths in a document-repository folder that a document row of
   * this dossier pointed at. Not deleted automatically: ops must check them.
   */
  files_for_review: string[];
  audit_complete: boolean;
};

/**
 * Whether the admin page may offer Anonymize, as far as the on-chain passport
 * goes. FAILS CLOSED: only a finished lookup that found no live entry (or a
 * dossier without a wallet, or a network without any KYC registry) is "none".
 *   live     an Approved, unexpired KycEntry exists — revoke it first;
 *   loading  the registry or the entry is still being read;
 *   unknown  the read failed, or several registries exist and none is live.
 * The server checks again before erasing (lib/server/passport-state.ts), so
 * this is the courtesy half of the gate.
 */
export type ErasurePassportCheck = "none" | "live" | "loading" | "unknown";

/** KycStatus.Approved (asset_registry enum order: Pending, Approved, Revoked, Expired). */
export const KYC_STATUS_APPROVED = 1;

export function erasurePassportCheck(input: {
  wallet: string | null | undefined;
  /** KycAuthorityContext: undefined = loading, null = failed. */
  kycCtx: { ambiguous: boolean; registry: unknown } | null | undefined;
  /** KycEntry: undefined = not read, null = none (or failed, see passportError). */
  passport: { status: number; expiry: bigint | number } | null | undefined;
  passportLoading: boolean;
  passportError: boolean;
  nowSec: number;
}): ErasurePassportCheck {
  if (!input.wallet) return "none";
  const ctx = input.kycCtx;
  if (ctx === undefined) return "loading";
  if (ctx === null || ctx.ambiguous) return "unknown";
  if (!ctx.registry) return "none";
  if (input.passportLoading || input.passport === undefined) return "loading";
  if (input.passportError) return "unknown";
  const p = input.passport;
  if (p && p.status === KYC_STATUS_APPROVED && Number(p.expiry) > input.nowSec) return "live";
  return "none";
}
