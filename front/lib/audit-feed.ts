// Reading "Send to wallets" audit rows (share_class_distribution) for a feed.
//
// One transaction can have more than one final row: audit_events is
// append-only, and the browser (on confirmation, or a resume of the run
// later) and the retry worker (lib/server/distribution-audits, which checks
// every pending row's transaction on the chain) each append theirs. The
// browser cannot see the worker's row (anon has no SELECT on audit_events),
// so a resume after it still appends one. collapseDistributionFinals keeps
// one final row per signature: the server's chain-checked row when there is
// one (its status is the finalized chain's), else the earliest; the others
// are counted on it, never dropped silently: `duplicates` when they say the
// same status, `conflict` when they do not (a browser row that says
// "success" next to the chain's "failed", for one: shown as a status
// conflict, never as one more duplicate). Pending rows and every other kind
// of row pass through unchanged.
//
// Which row is the server's is decided by /api/audit/list (chain_checked,
// lib/server/reconciled-audit: the row id derived from the signature, which
// the unsigned /api/audit cannot write), never by the row's metadata:
// /api/audit copies a caller's metadata, so a key like reconciled_by_server
// proves nothing. A server row asserts only the chain status: its
// metadata.client_claims are what the pending row reported, unverified
// (clientClaimsOf: the claimed actor and target, which a feed shows and
// searches labelled "unverified claim").

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

function isDistributionFinal(row: FeedAuditRow): row is FeedAuditRow & { tx_signature: string } {
  return (
    row.ix_name === DISTRIBUTION_IX &&
    (row.status === "success" || row.status === "failed") &&
    typeof row.tx_signature === "string" &&
    row.tx_signature.length > 0
  );
}

/**
 * Final rows of one signature that do not say what the row kept for it says:
 * `status` is the kept row's (the finalized chain's when `chainChecked`),
 * `statuses` what the others say instead, `rows` how many of them.
 */
export type StatusConflict = { status: string; chainChecked: boolean; statuses: string[]; rows: number };

/**
 * What the pending row reported, as a chain-checked row carries it
 * (metadata.client_claims, verified: false): the actor and the target it
 * claimed. Null on any other row, or when it claimed neither.
 */
export function clientClaimsOf(
  row: Pick<FeedAuditRow, "chain_checked" | "actor_wallet" | "metadata">,
): { actor: string | null; target: string | null } | null {
  if (!isChainChecked(row)) return null;
  const claims = row.metadata?.client_claims;
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) return null;
  const { actor_wallet: actor, target_label: target } = claims as Record<string, unknown>;
  const out = {
    actor: typeof actor === "string" && actor.length > 0 ? actor : null,
    target: typeof target === "string" && target.length > 0 ? target : null,
  };
  return out.actor === null && out.target === null ? null : out;
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
 * signature (the server's, else the earliest): `duplicates` counts the other
 * final rows of that signature that say the same status, `conflict` the ones
 * that do not (null when none does; 0 and null on every other row).
 */
export function collapseDistributionFinals<T extends FeedAuditRow>(
  rows: readonly T[],
): (T & { duplicates: number; conflict: StatusConflict | null })[] {
  const keep = new Map<string, T>();
  const finals = new Map<string, T[]>();
  for (const row of rows) {
    if (!isDistributionFinal(row)) continue;
    const signature = row.tx_signature;
    finals.set(signature, [...(finals.get(signature) ?? []), row]);
    const current = keep.get(signature);
    if (!current || preferred(row, current)) keep.set(signature, row);
  }
  const out: (T & { duplicates: number; conflict: StatusConflict | null })[] = [];
  for (const row of rows) {
    if (!isDistributionFinal(row)) {
      out.push({ ...row, duplicates: 0, conflict: null });
      continue;
    }
    if (keep.get(row.tx_signature) !== row) continue;
    const others = (finals.get(row.tx_signature) ?? []).filter((r) => r !== row);
    const disagree = others.filter((r) => r.status !== row.status);
    out.push({
      ...row,
      duplicates: others.length - disagree.length,
      conflict:
        disagree.length === 0
          ? null
          : { status: row.status, chainChecked: isChainChecked(row), statuses: [...new Set(disagree.map((r) => r.status))], rows: disagree.length },
    });
  }
  return out;
}
