// SERVER-ONLY — telling the retry worker's "Send to wallets" audit rows
// (lib/server/distribution-audits) apart from every other row.
//
// POST /api/audit is unsigned: it copies the caller's metadata and accepts a
// share_class_distribution row with a final status from anyone who sets the
// Origin header. So no metadata key (reconciled_by_server, chain_outcome…)
// can mark a row as the server's: anyone can write it. What a caller of
// /api/audit can never choose:
//   - the row id: the worker's final row for a transaction has the id
//     reconciledAuditId(network, signature), a UUID derived from the
//     signature; /api/audit never sends an id, so the database draws one;
//   - metadata.actor_source: /api/audit overwrites it with "siws-session" or
//     "client-unsigned", never RECONCILER;
//   - actor_wallet SERVER_ACTOR: /api/audit refuses it.
// isReconciledAuditRow requires all of them. /api/audit/list computes each
// row's chain_checked from it (the admin audit page reads that flag, never
// the metadata), and the worker's stage counts a transaction as settled only
// when this row exists (its id), not when any self-asserted final row does.
//
// /api/audit also drops RECONCILED_METADATA_KEYS from a caller's metadata
// (the vocabulary of the server's row), so a client row cannot carry them.

import "server-only";

import { createHash } from "node:crypto";
import { SERVER_ACTOR } from "@/lib/server/audit";

export const DISTRIBUTION_AUDIT_IX = "share_class_distribution";
/** metadata.actor_source / reconciled_by of the worker's rows (/api/audit never writes it). */
export const RECONCILER = "retry-worker";

/**
 * The metadata keys only the server's row asserts (lib/server/distribution-audits
 * reconciledAuditRow; the server stamps server_received_at, actor_verified and
 * actor_source are overwritten by /api/audit anyway). /api/audit drops them
 * from a caller's metadata.
 */
export const RECONCILED_METADATA_KEYS: readonly string[] = [
  "reconciled_by_server",
  "reconciled_by",
  "chain_outcome",
  "slot",
  "confirmation_status",
  "tx_error",
  "expiry_horizon_ms",
  "pending_row_ids",
  "pending_rows",
  "pending_created_at",
  "client_claims",
];

/**
 * The id of the server's final row for one transaction: a UUID (version 8,
 * RFC 9562) from SHA-256 of the network and the signature, so a second
 * write of it is a conflict, never a second row.
 */
export function reconciledAuditId(network: string, signature: string): string {
  const h = createHash("sha256").update(`manci:distribution-audit:v1:${network}:${signature}`).digest();
  h[6] = (h[6] & 0x0f) | 0x80;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** An audit_events row as read (every field optional: a reader selects what it needs). */
export type AuditRowLike = {
  id?: unknown;
  ix_name?: unknown;
  actor_wallet?: unknown;
  tx_signature?: unknown;
  status?: unknown;
  metadata?: unknown;
};

/**
 * Whether `row` is the retry worker's final row for its transaction on
 * `network`: its id is reconciledAuditId(network, its signature), its actor
 * SERVER_ACTOR and its metadata.actor_source RECONCILER — none of which
 * /api/audit lets a caller write.
 */
export function isReconciledAuditRow(network: string, row: AuditRowLike): boolean {
  if (row.ix_name !== DISTRIBUTION_AUDIT_IX || row.actor_wallet !== SERVER_ACTOR) return false;
  if (row.status !== "success" && row.status !== "failed") return false;
  if (typeof row.tx_signature !== "string" || row.tx_signature.length === 0) return false;
  const metadata = row.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return false;
  if ((metadata as Record<string, unknown>).actor_source !== RECONCILER) return false;
  return typeof row.id === "string" && row.id.toLowerCase() === reconciledAuditId(network, row.tx_signature);
}
