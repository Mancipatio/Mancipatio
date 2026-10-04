// A bounded retry for a chain READ that the RPC refuses for a moment.
//
// Right after a send, the tokenize checklist re-reads the token's state, and
// a public RPC that answered that burst with HTTP 429 left "Could not read
// the token's state from the chain" on screen until the user clicked "Try
// again" (mainnet, first tokenization, 2026-10-04). withRpcReadRetry retries
// such a read a few times on its own.
//
// Only transient failures are retried: HTTP 429 (rate limit), an HTTP 5xx,
// and a request that got no answer at all (fetch rejects with a TypeError:
// "Failed to fetch", "fetch failed", "Load failed", "NetworkError…"). The
// HTTP status is read from the error's code and context, never from its
// message (production builds of @solana/kit shorten messages). Anything
// else — a decode error, an account that is not what it should be, an
// aborted request — and the last transient failure are rethrown as they
// are, so the caller's error UI stays what it was.
//
// At most RPC_READ_RETRY_DELAYS_MS.length retries, after ~0.5, 1 and 2 s,
// each ±25 % (jitter, so several reads refused together do not come back
// together). Reads only: a send is never retried here.
//
// An AbortSignal (options.signal) ends it: no new attempt and no further
// wait once it aborts (a wait in progress ends at once), and the abort's
// reason is thrown instead of the read's own outcome. The read gets the
// signal too, for a request that can be cancelled. The tokenize checklist
// aborts a load that a newer load superseded or that its unmount abandoned.
//
// Directive-free and node-safe (sleep and random are injectable):
// tests/rpc-retry.test.ts.
import { isSolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR } from "@solana/kit";

/** The waits before retry 1, 2 and 3 (before jitter). */
export const RPC_READ_RETRY_DELAYS_MS: readonly number[] = [500, 1_000, 2_000];
/** Each wait is moved by up to this fraction, either way. */
export const RPC_READ_RETRY_JITTER = 0.25;

/** How deep a `cause` chain is followed (a wrapper around the RPC's error). */
const MAX_CAUSE_DEPTH = 4;

/** fetch()'s own rejections when no response came back (browsers and Node). */
const NETWORK_MESSAGE_RE = /failed to fetch|fetch failed|load failed|networkerror|network request failed/i;

function transientHere(error: unknown): boolean {
  if (isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
    const status = error.context.statusCode;
    return status === 429 || (status >= 500 && status <= 599);
  }
  // fetch() rejects with a TypeError when the request never got a response.
  return error instanceof TypeError && NETWORK_MESSAGE_RE.test(error.message);
}

/** Whether a failed RPC read is worth retrying: HTTP 429, HTTP 5xx, or no response (network). */
export function isTransientRpcError(error: unknown): boolean {
  let cursor: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && cursor !== null && cursor !== undefined; depth++) {
    if (transientHere(cursor)) return true;
    cursor = typeof cursor === "object" ? (cursor as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/** One wait: `base` ms moved by up to ±RPC_READ_RETRY_JITTER of it, never negative. */
export function retryDelayMs(base: number, random: () => number = Math.random): number {
  const spread = base * RPC_READ_RETRY_JITTER;
  return Math.max(0, Math.round(base - spread + random() * 2 * spread));
}

export type RpcReadRetryOptions = {
  /** The waits before each retry (default RPC_READ_RETRY_DELAYS_MS); its length bounds the retries. */
  delaysMs?: readonly number[];
  /** Waits `ms`; ends early (rejects) when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  /** Stops the retries: once it aborts, nothing more is read or waited for, and its reason is thrown. */
  signal?: AbortSignal;
};

/** What an aborted signal throws (its reason, or an AbortError when it has none). */
function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/** setTimeout as a promise that an abort ends at once (and clears the timer). */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * `read()`, retried after a transient RPC failure (isTransientRpcError) at
 * most `delaysMs.length` times with a jittered backoff. Any other failure,
 * and the transient one of the last attempt, is thrown unchanged. After
 * `signal` aborts, no further read or wait starts and the abort's reason is
 * thrown (also when the read in flight then fails).
 */
export async function withRpcReadRetry<T>(
  read: (signal?: AbortSignal) => Promise<T>,
  options: RpcReadRetryOptions = {},
): Promise<T> {
  const delays = options.delaysMs ?? RPC_READ_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? abortableSleep;
  const signal = options.signal;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw abortError(signal);
    try {
      return await read(signal);
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      if (attempt >= delays.length || !isTransientRpcError(error)) throw error;
      await sleep(retryDelayMs(delays[attempt], options.random), signal);
    }
  }
}
