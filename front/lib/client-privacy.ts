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
  files_deleted: number;
  /** Document rows whose file was not in the private bucket (legacy objects). */
  files_missing: number;
  /** Files that could not be deleted after the database was erased. */
  files_left: number;
  audit_complete: boolean;
};
