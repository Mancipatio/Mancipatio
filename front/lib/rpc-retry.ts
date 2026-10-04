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
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `read()`, retried after a transient RPC failure (isTransientRpcError) at
 * most `delaysMs.length` times with a jittered backoff. Any other failure,
 * and the transient one of the last attempt, is thrown unchanged.
 */
export async function withRpcReadRetry<T>(read: () => Promise<T>, options: RpcReadRetryOptions = {}): Promise<T> {
  const delays = options.delaysMs ?? RPC_READ_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= delays.length || !isTransientRpcError(error)) throw error;
      await sleep(retryDelayMs(delays[attempt], options.random));
    }
  }
}
