"use client";

import {
  isAddress,
  isSignature,
  type GetSignatureStatusesApi,
  type GetTransactionApi,
  type Rpc,
  type Signature,
} from "@solana/kit";
import type { Network } from "@/lib/network";
import { withRpcReadRetry, type RpcReadRetryOptions } from "@/lib/rpc-retry";
import { STATUS_READ_TIMEOUT_MS } from "@/lib/simulation-gate";

export type ChainRecordKind =
  | "purchase"
  | "delivery"
  | "conversion"
  | "delivery_return"
  | "conversion_return"
  | "custody_outcome";
export type ChainRecordScope = {
  kind: ChainRecordKind;
  network: Network;
  wallet: string;
  entityId: string;
};
export type PendingChainRecord = ChainRecordScope & {
  version: 1;
  signature: string;
  createdAt: string;
};

const PREFIX = "mancipatio:chain-record:v1:";
const KINDS: ChainRecordKind[] = [
  "purchase",
  "delivery",
  "conversion",
  "delivery_return",
  "conversion_return",
  "custody_outcome",
];
const NETWORKS: string[] = ["mainnet", "devnet", "testnet", "localnet"];

function scopeKey(scope: ChainRecordScope): string {
  if (
    !KINDS.includes(scope.kind) ||
    !NETWORKS.includes(scope.network) ||
    !isAddress(scope.wallet) ||
    !scope.entityId ||
    scope.entityId.length > 200
  ) {
    throw new Error("Invalid transaction recovery scope.");
  }
  return `${PREFIX}${scope.kind}:${scope.network}:${scope.wallet}:${encodeURIComponent(scope.entityId)}`;
}

function storage(): Storage {
  if (typeof window === "undefined")
    throw new Error("Browser storage is unavailable.");
  return window.localStorage;
}

/** Call before sending funds so blocked storage is discovered before signing. */
export function assertChainRecordStorageAvailable(): void {
  try {
    const store = storage();
    const probe = `${PREFIX}probe:${Date.now()}:${Math.random()}`;
    store.setItem(probe, "1");
    if (store.getItem(probe) !== "1") throw new Error("Storage write failed");
    store.removeItem(probe);
  } catch {
    throw new Error(
      "Enable browser storage before sending this transaction so its receipt can be recovered after a refresh.",
    );
  }
}

function parseRecord(
  raw: string | null,
  key: string,
): PendingChainRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as PendingChainRecord;
    if (
      value.version !== 1 ||
      scopeKey(value) !== key ||
      !isSignature(value.signature) ||
      typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt))
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

/** Store only public transaction identity, never request details or tokens. */
export function savePendingChainRecord(
  input: ChainRecordScope & { signature: string },
): PendingChainRecord {
  const key = scopeKey(input);
  if (!isSignature(input.signature))
    throw new Error("Invalid transaction signature.");
  const record: PendingChainRecord = {
    version: 1,
    kind: input.kind,
    network: input.network,
    wallet: input.wallet,
    entityId: input.entityId,
    signature: input.signature,
    createdAt: new Date().toISOString(),
  };
  try {
    const store = storage();
    store.setItem(key, JSON.stringify(record));
    if (parseRecord(store.getItem(key), key)?.signature !== record.signature)
      throw new Error("Storage write failed");
  } catch {
    throw new Error(
      "The transaction was sent, but its receipt could not be saved in this browser. Keep the transaction signature and retry recording it; do not send the funds again.",
    );
  }
  return record;
}

export function readPendingChainRecord(
  scope: ChainRecordScope,
): PendingChainRecord | null {
  const key = scopeKey(scope);
  try {
    return parseRecord(storage().getItem(key), key);
  } catch {
    return null;
  }
}

/** A delayed response must not delete the receipt for a newer transaction. */
export function clearPendingChainRecord(
  record: ChainRecordScope & { signature: string },
): void {
  const key = scopeKey(record);
  const store = storage();
  if (parseRecord(store.getItem(key), key)?.signature === record.signature)
    store.removeItem(key);
}

/**
 * Entries have no automatic TTL: finalization/database recovery can take
 * time. A receipt leaves storage only when recording succeeds
 * (clearPendingChainRecord) or when the network provably never ran its
 * transaction (discardPendingChainRecord, after checkPendingChainRecord).
 */
export function listPendingChainRecords(
  scope: Omit<ChainRecordScope, "entityId">,
): PendingChainRecord[] {
  const prefix = scopeKey({ ...scope, entityId: "probe" }).slice(
    0,
    -"probe".length,
  );
  try {
    const store = storage();
    const records: PendingChainRecord[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (!key?.startsWith(prefix)) continue;
      const record = parseRecord(store.getItem(key), key);
      if (record) records.push(record);
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch {
    return [];
  }
}

// ── What became of a receipt's transaction ───────────────────────────────────

/**
 * How long after `createdAt` a signature the network does not know (at
 * finalized, with the transaction history searched) can no longer land. A
 * receipt is saved right after the send resolved, with a blockhash fetched
 * moments before, so the transaction's own lifetime (~60-90 s) is long over
 * by then; receipts record no lastValidBlockHeight, so this is the bound.
 * The server's analogue, for its own rows, is
 * lib/server/distribution-audits.ts EXPIRY_HORIZON_MS (6 h).
 */
export const RECEIPT_EXPIRY_HORIZON_MS = 24 * 60 * 60_000;

/**
 * - landed: confirmed or finalized without an error (the record can be made).
 * - failed: the network ran it and it failed (confirmed or finalized with an
 *   error): nothing moved, the receipt may be discarded.
 * - pending: processed, or unknown to the network before the horizon.
 * - did_not_land: unknown to the network after the horizon, and no
 *   transaction at finalized: it can no longer land, nothing moved.
 * - unknown: the network could not be asked (fail closed: keep the receipt).
 */
export type ChainRecordState =
  | "landed"
  | "failed"
  | "pending"
  | "did_not_land"
  | "unknown";

export type SignatureStatusLike =
  | { err: unknown; confirmationStatus?: string | null }
  | null
  | undefined;

/** A getTransaction answer at finalized: `undefined` when it was not read. */
export type LandedTransactionLike =
  | { meta?: { err: unknown } | null }
  | null
  | undefined;

function settled(status: SignatureStatusLike): boolean {
  return (
    status?.confirmationStatus === "confirmed" ||
    status?.confirmationStatus === "finalized"
  );
}

/** Whether the horizon has passed for a receipt created at `createdAt` (an unreadable date never has). */
export function pastReceiptHorizon(
  createdAt: string,
  now: number = Date.now(),
): boolean {
  return now - Date.parse(createdAt) >= RECEIPT_EXPIRY_HORIZON_MS;
}

/** Pure: the state of a receipt from one status read and, past the horizon, one transaction read. */
export function receiptChainState(
  status: SignatureStatusLike,
  landedTx: LandedTransactionLike,
  createdAt: string,
  now: number = Date.now(),
): ChainRecordState {
  if (status) {
    if (status.err) return settled(status) ? "failed" : "pending";
    return settled(status) ? "landed" : "pending";
  }
  if (!pastReceiptHorizon(createdAt, now) || landedTx === undefined)
    return "pending";
  if (landedTx === null) return "did_not_land";
  return landedTx.meta?.err ? "failed" : "landed";
}

export type ChainRecordRpc = Rpc<GetSignatureStatusesApi & GetTransactionApi>;

/**
 * Asks the network what became of a receipt's transaction. One status read
 * (the transaction history searched); only a signature the network does not
 * know after the horizon is looked up as a transaction at finalized, so an
 * old receipt is never declared dead on the status cache alone. A read that
 * fails answers "unknown".
 */
export async function checkPendingChainRecord(
  rpc: ChainRecordRpc,
  record: Pick<PendingChainRecord, "signature" | "createdAt">,
  now: number = Date.now(),
): Promise<ChainRecordState> {
  try {
    const { value } = await rpc
      .getSignatureStatuses([record.signature as Signature], {
        searchTransactionHistory: true,
      })
      .send({ abortSignal: AbortSignal.timeout(STATUS_READ_TIMEOUT_MS) });
    const status = value[0];
    if (status || !pastReceiptHorizon(record.createdAt, now))
      return receiptChainState(status, undefined, record.createdAt, now);
    const tx = await rpc
      .getTransaction(record.signature as Signature, {
        commitment: "finalized",
        encoding: "json",
        maxSupportedTransactionVersion: 0,
      })
      .send({ abortSignal: AbortSignal.timeout(STATUS_READ_TIMEOUT_MS) });
    return receiptChainState(status, tx, record.createdAt, now);
  } catch {
    return "unknown";
  }
}

/** Only a transaction the network ran and failed, or can no longer run, may be discarded. */
export function discardableChainRecordState(
  state: ChainRecordState,
): state is "failed" | "did_not_land" {
  return state === "failed" || state === "did_not_land";
}

/**
 * Removes a receipt the network provably never executed. Refused (false)
 * for any other state and when storage no longer holds this exact
 * signature (a newer receipt is never deleted by an old decision).
 */
export function discardPendingChainRecord(
  record: ChainRecordScope & { signature: string },
  state: ChainRecordState,
): boolean {
  if (!discardableChainRecordState(state)) return false;
  const key = scopeKey(record);
  const store = storage();
  if (parseRecord(store.getItem(key), key)?.signature !== record.signature)
    return false;
  store.removeItem(key);
  return true;
}

// ── Finalization before the signed record ────────────────────────────────────

/**
 * The evidence routes verify a transaction at finalized, so a record sent
 * right after submission used to fail and cost a second wallet prompt. The
 * hooks wait this long (plain RPC reads, no prompt) before the ONE signed
 * record; what the wait leaves open is retried after RECORD_RETRY_DELAYS_MS
 * (each wait re-reads the status for FINALIZATION_RECHECK_MS), then handed
 * to the manual "Retry recording".
 */
export const FINALIZATION_WAIT_MS = 60_000;
export const FINALIZATION_RECHECK_MS = 10_000;
export const FINALIZATION_POLL_MS = 2_000;
export const RECORD_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 30_000];

/**
 * The server's "sent, not finalized yet" refusal (lib/server/chain-evidence.ts
 * AwaitingFinalizationError: a 409 whose `code` is "awaiting_finalization"
 * and whose message opens with "Awaiting finalization"). signedFetch
 * surfaces the message, so its opening words are what the client reads; a
 * `code` on the error is honoured first, for the day the envelope carries it.
 * The older "… is awaiting finalization" messages match as well.
 */
export const AWAITING_FINALIZATION_CODE = "awaiting_finalization";
export const AWAITING_FINALIZATION_RE = /awaiting finalization/i;
export function isAwaitingFinalizationError(error: unknown): boolean {
  if (
    error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === AWAITING_FINALIZATION_CODE
  )
    return true;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return AWAITING_FINALIZATION_RE.test(message);
}

export type FinalizedSignatureOutcome =
  | "finalized"
  | "failed"
  | "timeout"
  | "unknown";

export type FinalizedWaitOptions = {
  /** How long to wait in all (default FINALIZATION_WAIT_MS). */
  timeoutMs?: number;
  /** Between two reads (default FINALIZATION_POLL_MS). */
  pollMs?: number;
  /** Checked after each read: true ends the wait as "unknown". */
  isCancelled?: () => boolean;
  /**
   * Retry a status read the RPC refused for a moment (lib/rpc-retry), within
   * the timeout; on by default, `false` answers "unknown" at once.
   */
  retryReads?: boolean | Pick<RpcReadRetryOptions, "delaysMs" | "sleep" | "random">;
};

/**
 * Polls one signature (the transaction history searched) until it is
 * finalized without an error, failed (an error at confirmed or finalized),
 * the timeout passes, or the status cannot be read. Like
 * lib/simulation-gate waitForSignature, but "confirmed" keeps polling: the
 * evidence routes read at finalized.
 */
export async function waitForFinalizedSignature(
  rpc: Rpc<GetSignatureStatusesApi>,
  signature: string,
  options: FinalizedWaitOptions = {},
): Promise<FinalizedSignatureOutcome> {
  const timeoutMs = options.timeoutMs ?? FINALIZATION_WAIT_MS;
  const pollMs = options.pollMs ?? FINALIZATION_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  const retry =
    options.retryReads === false
      ? null
      : options.retryReads === undefined || options.retryReads === true
        ? {}
        : options.retryReads;
  // The retries end with the timeout: no further read or wait starts after it.
  const stop = retry ? new AbortController() : null;
  const timer = stop ? setTimeout(() => stop.abort(), timeoutMs) : null;
  try {
    for (;;) {
      const read = async (): Promise<SignatureStatusLike> =>
        (
          await rpc
            .getSignatureStatuses([signature as Signature], {
              searchTransactionHistory: true,
            })
            .send({ abortSignal: AbortSignal.timeout(STATUS_READ_TIMEOUT_MS) })
        ).value[0];
      let status: SignatureStatusLike;
      try {
        status =
          retry && stop
            ? await withRpcReadRetry(read, { ...retry, signal: stop.signal })
            : await read();
      } catch {
        return stop?.signal.aborted ? "timeout" : "unknown";
      }
      if (status?.err && settled(status)) return "failed";
      if (status?.confirmationStatus === "finalized" && !status.err)
        return "finalized";
      if (options.isCancelled?.()) return "unknown";
      if (Date.now() + pollMs > deadline) return "timeout";
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── The record itself: once finalized, once ─────────────────────────────────

export type RecordingStage =
  /** Polling the transaction's status (plain RPC reads, no wallet prompt). */
  | "awaiting_finalization"
  /** The one signed record is in flight (the wallet signs the request). */
  | "recording"
  /** Between two attempts (RECORD_RETRY_DELAYS_MS). */
  | "retry_wait";

export type RecordingOutcome =
  /** The server accepted the record. */
  | "recorded"
  /** The network ran the transaction and it failed: nothing moved. */
  | "failed"
  /** Not finalized within the wait and its retries; the receipt stays for "Retry recording". */
  | "not_finalized";

export type RecordOnceFinalizedInput = {
  /** Waits up to `timeoutMs` for the transaction to finalize (waitForFinalizedSignature or alike). */
  waitForFinalized: (timeoutMs: number) => Promise<FinalizedSignatureOutcome>;
  /** The signed record (one POST). An error other than "awaiting finalization" ends the attempt. */
  record: () => Promise<void>;
  /** Each stage change, with the attempt number (0 = the first). */
  onStage?: (stage: RecordingStage, attempt: number) => void;
  /** The first wait (default FINALIZATION_WAIT_MS). */
  waitMs?: number;
  /** Each later wait, after a backoff (default FINALIZATION_RECHECK_MS). */
  recheckMs?: number;
  /** The backoffs (default RECORD_RETRY_DELAYS_MS); their count bounds the retries. */
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
};

/**
 * The shared record path of a sent transaction: wait for it to finalize
 * (the evidence routes verify at finalized), then record it ONCE. A wait
 * that runs out, and a server that answers "awaiting finalization" (its
 * node lags), are retried after RECORD_RETRY_DELAYS_MS — each retry reads
 * the status again first, so a signed request is only sent while the
 * network here shows the transaction finalized — before the manual "Retry
 * recording" takes over ("not_finalized"; the receipt is kept). A
 * transaction the network ran and failed ends it at once ("failed":
 * nothing moved, the receipt may be discarded). Any other error of
 * `record` is thrown as it is. Node-safe: the hooks pass in the rpc reads.
 */
export async function recordOnceFinalized(
  input: RecordOnceFinalizedInput,
): Promise<RecordingOutcome> {
  const delays = input.delaysMs ?? RECORD_RETRY_DELAYS_MS;
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  input.onStage?.("awaiting_finalization", 0);
  let outcome = await input.waitForFinalized(
    input.waitMs ?? FINALIZATION_WAIT_MS,
  );
  for (let attempt = 0; ; attempt++) {
    if (outcome === "failed") return "failed";
    if (outcome === "finalized") {
      input.onStage?.("recording", attempt);
      try {
        await input.record();
        return "recorded";
      } catch (error) {
        if (!isAwaitingFinalizationError(error)) throw error;
      }
    }
    if (attempt >= delays.length) return "not_finalized";
    input.onStage?.("retry_wait", attempt + 1);
    await sleep(delays[attempt]);
    input.onStage?.("awaiting_finalization", attempt + 1);
    outcome = await input.waitForFinalized(
      input.recheckMs ?? FINALIZATION_RECHECK_MS,
    );
  }
}
