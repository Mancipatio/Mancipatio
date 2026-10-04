// Reading audit rows for a feed: "Send to wallets" rows
// (share_class_distribution) and recorded document anchors.
//
// One transaction can have more than one final row: audit_events is
// append-only, and the browser (on confirmation, or a resume of the run
// later) and the retry worker (lib/server/distribution-audits, which checks
// every pending row's transaction on the chain) each append theirs. The
// browser cannot see the worker's row (anon has no SELECT on audit_events),
// so a resume after it still appends one. collapseDistributionFinals keeps
// one final row per signature: the server's chain-checked row when there is
// one (its status is the finalized chain's), else the earliest; the others
// are counted on it (`duplicates`), never dropped silently. Pending rows and
// every other kind of row pass through unchanged.
//
// Which row is the server's is decided by /api/audit/list (chain_checked,
// lib/server/reconciled-audit: the row id derived from the signature, which
// the unsigned /api/audit cannot write), never by the row's metadata:
// /api/audit copies a caller's metadata, so a key like reconciled_by_server
// proves nothing. A server row asserts only the chain status: its
// metadata.client_claims are what the pending row reported, unverified.
//
// A recorded document anchor (isVerifiedDocumentAnchor) is likewise told by
// what the unsigned /api/audit cannot write: its category, "operator".

import { DOCUMENT_ANCHOR_AUDIT } from "@/lib/document-anchor";

export const DISTRIBUTION_IX = "share_class_distribution";
/** actor_wallet and metadata.actor_source of the retry worker's rows (lib/server/reconciled-audit). */
const SERVER_ACTOR = "server";
const RECONCILER = "retry-worker";

export type FeedAuditRow = {
  id: string;
  created_at: string;
  ix_name: string;
  tx_signature: string | null;
  status: string;
  actor_wallet?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Set by /api/audit/list (lib/server/reconciled-audit isReconciledAuditRow); absent: not the server's row. */
  chain_checked?: boolean;
};

/**
 * A final row the retry worker appended from the chain: /api/audit/list
 * said so (chain_checked), and its actor and actor_source agree. Metadata
 * markers alone (reconciled_by_server) never make a row chain-checked.
 */
export function isChainChecked(row: Pick<FeedAuditRow, "chain_checked" | "actor_wallet" | "metadata">): boolean {
  return row.chain_checked === true && row.actor_wallet === SERVER_ACTOR && row.metadata?.actor_source === RECONCILER;
}

/**
 * A recorded document anchor (app/api/admin/document-anchor): that route
 * writes the row only after it verified the anchor's FINALIZED transaction on
 * chain (lib/document-anchor documentAnchorEvidence). The category alone
 * says the row is the route's: "operator" is server-only (the unsigned
 * /api/audit refuses it, lib/server/audit SERVER_ONLY_AUDIT_CATEGORIES, and
 * anon has no INSERT on audit_events), so no caller can post a row that
 * passes for one.
 */
export function isVerifiedDocumentAnchor(row: { category?: unknown; ix_name: string }): boolean {
  return row.category === DOCUMENT_ANCHOR_AUDIT.category && row.ix_name === DOCUMENT_ANCHOR_AUDIT.ixName;
}

function isDistributionFinal(row: FeedAuditRow): row is FeedAuditRow & { tx_signature: string } {
  return (
    row.ix_name === DISTRIBUTION_IX &&
    (row.status === "success" || row.status === "failed") &&
    typeof row.tx_signature === "string" &&
    row.tx_signature.length > 0
  );
}

/** Whether `a` stands for its signature rather than `b`: chain-checked first, then the earliest. */
function preferred(a: FeedAuditRow, b: FeedAuditRow): boolean {
  const ca = isChainChecked(a);
  const cb = isChainChecked(b);
  if (ca !== cb) return ca;
  return a.created_at !== b.created_at ? a.created_at < b.created_at : a.id < b.id;
}

/**
 * The rows in their order, with one final share_class_distribution row per
 * signature (the server's, else the earliest), `duplicates` counting the
 * other final rows of that signature (0 on every other row).
 */
export function collapseDistributionFinals<T extends FeedAuditRow>(rows: readonly T[]): (T & { duplicates: number })[] {
  const keep = new Map<string, T>();
  const count = new Map<string, number>();
  for (const row of rows) {
    if (!isDistributionFinal(row)) continue;
    const signature = row.tx_signature;
    count.set(signature, (count.get(signature) ?? 0) + 1);
    const current = keep.get(signature);
    if (!current || preferred(row, current)) keep.set(signature, row);
  }
  const out: (T & { duplicates: number })[] = [];
  for (const row of rows) {
    if (!isDistributionFinal(row)) {
      out.push({ ...row, duplicates: 0 });
      continue;
    }
    if (keep.get(row.tx_signature) !== row) continue;
    out.push({ ...row, duplicates: (count.get(row.tx_signature) ?? 1) - 1 });
  }
  return out;
}
