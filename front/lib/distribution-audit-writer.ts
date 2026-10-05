// The "pending" share_class_distribution audit row of each transaction of a
// "Send to wallets" run, written as soon as the transaction is journalled,
// BEFORE it is broadcast (components/send-to-wallets-panel, the onSigned hook
// of lib/verified-solana-client prepareAndSendAll, built by
// journalThenPendingAudits; batch and one-by-one alike).
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
// Shape is the session's own: distributionAuditRow with status "pending" and
// the run's screening evidence, written one after another (the audit route's
// burst limit), started once per signature. The broadcast waits for them at
// most PENDING_AUDIT_WAIT_MS, and never longer than the blockhash can spare
// above the margin the broadcast keeps (BatchSignedInfo.waitMs: a slow audit
// route never eats into that margin): the rest are written while it is
// sent, and settle() waits for every write after the group, writes once more
// each that failed, and says which signatures have their row (the journal
// marks them "pending"). The final rows are unchanged: the panel appends
// them once the network decided.
//
// What it does not close: a row still being written when the tab closes is
// delivered only if its request already left (the panel writes with
// keepalive, so a request in flight outlives the page; one still queued
// behind it does not), so a transaction broadcast after the wait can still
// land without its row. A write never hangs: each attempt is cut off after
// PENDING_AUDIT_ATTEMPT_TIMEOUT_MS (lib/supabase recordAudit), and the
// writer itself moves on after PENDING_AUDIT_WRITE_LIMIT_MS whatever
// `record` does, so one stuck write cannot hold up the ones after it. And a
// write whose answer was lost (inserted, then the network dropped, or a
// non-JSON answer) counts as failed: settle() writes it once more, leaving a
// second pending row for that signature (/api/audit has no idempotency
// key). Harmless: the retry worker groups pending rows by signature (one
// server row, the oldest row's claims) and the admin feed shows the extra
// pending row as it is.
//
// The rows are written after the transaction was signed, so after its
// blockhash was fetched: the retry worker's expiry horizon (counted from the
// oldest pending row) still starts after the transaction's lifetime began.
//
// Node-safe (no "use client", no React): tests/distribution-audit-writer.test.ts
// and tests/verified-batch-send.test.ts (a one-by-one run interrupted after
// its first transaction, through journalThenPendingAudits).
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

/** Each attempt of a pending row's POST is given up after this long (lib/supabase recordAudit `timeoutMs`). */
export const PENDING_AUDIT_ATTEMPT_TIMEOUT_MS = 10_000;

/**
 * The writer moves on to the next row after this long whatever `record`
 * does (recordAudit with PENDING_AUDIT_ATTEMPT_TIMEOUT_MS ends within ~42 s:
 * three attempts and the 429 waits). A row that answers later still counts.
 */
export const PENDING_AUDIT_WRITE_LIMIT_MS = 60_000;

export type PendingAuditWriter = {
  /**
   * Starts the pending row of each entry not started before (one write after
   * another, in order) and waits for them, at most `waitMs`.
   */
  writeSigned(entries: readonly PendingAuditEntry[], waitMs?: number): Promise<void>;
  /**
   * Waits for every write started for `signatures`, writes once more each
   * that did not get its row (a lost answer: a second row, see the header),
   * and returns the signatures that have one.
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
  /** Default PENDING_AUDIT_WRITE_LIMIT_MS (tests pass their own). */
  writeLimitMs?: number;
}): PendingAuditWriter {
  const writeLimitMs = input.writeLimitMs ?? PENDING_AUDIT_WRITE_LIMIT_MS;
  const entries = new Map<string, PendingAuditEntry>();
  const writes = new Map<string, Promise<boolean>>();
  const written = new Set<string>();
  // One write at a time, in the order they were started.
  let tail: Promise<unknown> = Promise.resolve();

  async function recordOnce(entry: PendingAuditEntry): Promise<boolean> {
    try {
      const id = await input.record(
        distributionAuditRow({ ...input.base(), signature: entry.signature, status: "pending", rows: entry.rows }),
      );
      if (id !== null) written.add(entry.signature);
      return id !== null;
    } catch {
      return false;
    }
  }

  function write(entry: PendingAuditEntry): Promise<boolean> {
    const attempt = tail.then(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // A record that never answers must not hold up the rows after it.
        return await Promise.race([
          recordOnce(entry),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), writeLimitMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
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

/**
 * prepareAndSendAll's onSigned hook for one group of a "Send to wallets" run
 * (components/send-to-wallets-panel): the caller's journal first (`journal`,
 * synchronous: the signatures are known before the network can see them),
 * then `onSending`, then the pending row of each transaction (`rowsOf` its
 * index in the group), waited for at most PENDING_AUDIT_WAIT_MS and never
 * longer than the blockhash can spare (`info.waitMs`, lib/verified-solana-client
 * BatchSignedInfo). Throws only what `journal` throws (nothing is sent then).
 */
export function journalThenPendingAudits<Signed extends { index: number; signature: string }>(input: {
  journal: (signed: readonly Signed[]) => void;
  audits: PendingAuditWriter;
  rowsOf: (index: number) => PendingAuditEntry["rows"];
  onSending?: (count: number) => void;
}): (signed: readonly Signed[], info: { waitMs: number }) => Promise<void> {
  return async (signed, info) => {
    input.journal(signed);
    input.onSending?.(signed.length);
    const waitMs = Math.min(PENDING_AUDIT_WAIT_MS, Math.max(0, Number.isFinite(info.waitMs) ? info.waitMs : 0));
    await input.audits.writeSigned(
      signed.map((s) => ({ signature: s.signature, rows: input.rowsOf(s.index) })),
      waitMs,
    );
  };
}
