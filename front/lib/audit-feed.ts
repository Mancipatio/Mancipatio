// Reading "Send to wallets" audit rows (share_class_distribution) for a feed.
//
// One transaction can have more than one final row: audit_events is
// append-only, and the browser (on confirmation, or a resume of the run
// later) and the retry worker (lib/server/distribution-audits, for a pending
// row the browser never confirmed) each append theirs. The worker skips a
// signature that already has a final row, but the browser cannot see the
// worker's row (anon has no SELECT on audit_events), so a resume after it
// still appends one. collapseDistributionFinals keeps one final row per
// signature: the server's chain-checked row when there is one (its status
// is the finalized chain's), else the earliest; the others are counted on
// it (`duplicates`), never dropped silently. Pending rows and every other
// kind of row pass through unchanged.
//
// A server row asserts only the chain status (chainChecked): its
// metadata.client_claims are what the pending row reported, unverified.

export const DISTRIBUTION_IX = "share_class_distribution";

export type FeedAuditRow = {
  id: string;
  created_at: string;
  ix_name: string;
  tx_signature: string | null;
  status: string;
  metadata?: Record<string, unknown> | null;
};

/** A final row the retry worker appended from the chain (metadata.reconciled_by_server). */
export function isChainChecked(row: Pick<FeedAuditRow, "metadata">): boolean {
  return row.metadata?.reconciled_by_server === true;
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
