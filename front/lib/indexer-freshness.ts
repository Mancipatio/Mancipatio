// When the indexer mirror (the Supabase tables the Helius webhook fills) may
// stand in for a chain read. Pure and shared, so there is one rule: the
// browser readers (lib/indexer.ts requireReady) and the server menu counts
// (lib/server/admin-badges.ts) both call it. lib/indexer.ts itself is a
// browser module (anon client, signedFetch), which a server module cannot
// import — hence this file.

/** The indexer_sync_state columns the rule reads. */
export type IndexerSyncState = {
  status?: string | null;
  checked_at?: string | null;
  completed_at?: string | null;
};

/** A check older than this makes the mirror stale. */
export const INDEXER_STALE_AFTER_MS = 5 * 60_000;
/** A check stamped further in the future than this is not trusted (clock skew). */
export const INDEXER_FUTURE_SKEW_MS = 30_000;

/**
 * True while the mirror is trustworthy: status `ready`, a completed first
 * reconcile, and a `checked_at` at most 5 minutes old and not more than 30 s
 * in the future. A missing row is never fresh.
 */
export function isIndexerStateFresh(
  row: IndexerSyncState | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!row || row.status !== "ready" || !row.completed_at) return false;
  const checked = Date.parse(row.checked_at ?? "");
  return (
    Number.isFinite(checked) &&
    checked <= nowMs + INDEXER_FUTURE_SKEW_MS &&
    nowMs - checked <= INDEXER_STALE_AFTER_MS
  );
}
