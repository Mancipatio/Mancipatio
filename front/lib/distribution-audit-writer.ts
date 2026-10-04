// The "pending" share_class_distribution audit row of each transaction of a
// "Send to wallets" run, written as soon as the transaction is journalled,
// BEFORE it is broadcast (components/send-to-wallets-panel, the onSigned hook
// of lib/verified-solana-client prepareAndSendAll; batch and one-by-one
// alike).
//
// Why: the retry worker settles from the chain only the transactions that
// have a pending row (lib/server/distribution-audits). The panel used to
// write the pending rows after prepareAndSendAll returned for a whole group
// (up to MAX_TRANSACTIONS_PER_PROMPT transactions). One by one (Phantom on
// mainnet), each transaction is broadcast and then waited for, up to
// SETTLE_TIMEOUT_MS, before the next prompt, so a tab closed in the middle of
// a group left transactions that had landed without any audit row, and
// nothing ever wrote one: a permanent gap in the audit trail.
//
// Shape and idempotency are the session's own: distributionAuditRow with
// status "pending" and the run's screening evidence, written one after
// another (the audit route's burst limit), never twice for a signature. The
// broadcast waits for them at most PENDING_AUDIT_WAIT_MS (a batch keeps at
// least 30 blocks of its blockhash when it is journalled, ~12 s; a slow
// audit route never costs it the blockhash): the rest are written while it
// is sent, and settle() waits for every write after the group, writes once
// more each that failed, and says which signatures have their row (the
// journal marks them "pending"). The final rows are unchanged: the panel
// appends them once the network decided.
//
// The rows are written after the transaction was signed, so after its
// blockhash was fetched: the retry worker's expiry horizon (counted from the
// oldest pending row) still starts after the transaction's lifetime began.
//
// Node-safe (no "use client", no React): tests/distribution-audit-writer.test.ts
// and tests/verified-batch-send.test.ts (a one-by-one run interrupted after
// its first transaction).
import { distributionAuditRow } from "@/lib/distribution-run";

/** One audit row as distributionAuditRow builds it. */
export type DistributionAuditRow = ReturnType<typeof distributionAuditRow>;

/** What every pending row of the run shares: read when each row is written (the screening evidence can be re-taken). */
export type PendingAuditBase = Omit<Parameters<typeof distributionAuditRow>[0], "signature" | "status" | "rows" | "extra">;

/** One journalled transaction: its signature and the rows it pays. */
export type PendingAuditEntry = { signature: string; rows: readonly { wallet: string; amount: bigint }[] };

/**
 * The longest the broadcast waits for the pending rows of what was just
 * signed; the rows still being written then are finished while it is sent.
 */
export const PENDING_AUDIT_WAIT_MS = 5_000;

export type PendingAuditWriter = {
  /**
   * Starts the pending row of each entry not started before (one write after
   * another, in order) and waits for them, at most `waitMs`.
   */
  writeSigned(entries: readonly PendingAuditEntry[], waitMs?: number): Promise<void>;
  /**
   * Waits for every write started for `signatures`, writes once more each
   * that did not get its row, and returns the signatures that have one.
   */
  settle(signatures: readonly string[]): Promise<Set<string>>;
  /** Waits for every write started (nothing new is written). */
  drain(): Promise<void>;
  /** Whether `signature`'s pending row was written. */
  has(signature: string): boolean;
};

export function createPendingAuditWriter(input: {
  /** Appends one row; the new row's id, or null when it was not written (lib/supabase recordAudit never throws). */
  record: (row: DistributionAuditRow) => Promise<string | null>;
  base: () => PendingAuditBase;
}): PendingAuditWriter {
  const entries = new Map<string, PendingAuditEntry>();
  const writes = new Map<string, Promise<boolean>>();
  const written = new Set<string>();
  // One write at a time, in the order they were started.
  let tail: Promise<unknown> = Promise.resolve();

  function write(entry: PendingAuditEntry): Promise<boolean> {
    const attempt = tail.then(async () => {
      try {
        const id = await input.record(
          distributionAuditRow({ ...input.base(), signature: entry.signature, status: "pending", rows: entry.rows }),
        );
        if (id !== null) written.add(entry.signature);
        return id !== null;
      } catch {
        return false;
      }
    });
    tail = attempt;
    writes.set(entry.signature, attempt);
    return attempt;
  }

  return {
    async writeSigned(list, waitMs = PENDING_AUDIT_WAIT_MS) {
      const started: Promise<boolean>[] = [];
      for (const entry of list) {
        if (entries.has(entry.signature)) continue;
        entries.set(entry.signature, entry);
        started.push(write(entry));
      }
      if (started.length === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(started),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, waitMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    async settle(signatures) {
      await Promise.all(signatures.map((s) => writes.get(s) ?? Promise.resolve(false)));
      for (const signature of signatures) {
        const entry = entries.get(signature);
        if (entry && !written.has(signature)) await write(entry);
      }
      return new Set(signatures.filter((s) => written.has(s)));
    },
    async drain() {
      await tail;
    },
    has: (signature) => written.has(signature),
  };
}
