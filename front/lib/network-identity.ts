import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  isBlockhash,
  isSolanaError,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  type GetGenesisHashApi,
  type Rpc,
  type RpcTransport,
} from "@solana/kit";
import type { Network } from "@/lib/network";
import { withRpcReadRetry, type RpcReadRetryOptions } from "@/lib/rpc-retry";

// Canonical genesis values from solana-cluster-type 3.1.0/3.2.0.
export const CLUSTER_GENESIS_HASHES = {
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
} as const;

export class NetworkIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkIdentityError";
  }
}

export function expectedGenesisHash(
  network: Network,
  configured = process.env.NEXT_PUBLIC_SOLANA_GENESIS_HASH,
): string {
  if (network !== "localnet") {
    const expected = CLUSTER_GENESIS_HASHES[network];
    if (!expected || (configured && configured !== expected)) {
      throw new NetworkIdentityError(
        "The configured genesis hash conflicts with the selected network.",
      );
    }
    return expected;
  }
  if (
    !configured ||
    !isBlockhash(configured) ||
    Object.values(CLUSTER_GENESIS_HASHES).some((hash) => hash === configured)
  ) {
    throw new NetworkIdentityError(
      "Localnet requires its own NEXT_PUBLIC_SOLANA_GENESIS_HASH before blockchain actions are enabled.",
    );
  }
  return configured;
}

export type NetworkVerifierOptions = {
  expectedHash?: string;
  cacheMs?: number;
  /**
   * Retry a genesis read the RPC refused for a moment (HTTP 429, a 5xx, no
   * response: lib/rpc-retry withRpcReadRetry), each attempt with its own
   * 10 s cut-off; `true` takes the default waits, tests pass their own. Off
   * by default: the server's verifier reads behind every request and caches
   * instead; the wallet client (lib/verified-solana-client) turns it on, so
   * one refused read is not the first thing every send fails on.
   */
  retryReads?: boolean | Pick<RpcReadRetryOptions, "delaysMs" | "sleep" | "random">;
};

/**
 * A verifier belongs to one RPC instance and one expected genesis identity.
 * Concurrent callers share one check (bounded by its own 10 s timeout per
 * read). A caller's `signal` bounds only that caller's wait: it rejects with
 * the signal's reason when it aborts, and the shared check goes on for the
 * others.
 */
export function createNetworkVerifier(
  rpc: Rpc<GetGenesisHashApi>,
  network: Network,
  options: NetworkVerifierOptions = {},
) {
  const expected = expectedGenesisHash(network, options.expectedHash);
  const cacheMs = options.cacheMs ?? 0;
  const retry = options.retryReads ? (options.retryReads === true ? {} : options.retryReads) : null;
  let verifiedAt: number | null = null;
  let pending: Promise<void> | null = null;

  // A fresh cut-off per attempt.
  const read = () => rpc.getGenesisHash().send({ abortSignal: AbortSignal.timeout(10_000) });

  const check = async () => {
    let actual: string;
    try {
      actual = retry ? await withRpcReadRetry(read, retry) : await read();
    } catch (cause) {
      // RPC exceptions can contain URLs/API keys. Return only this safe
      // message; an HTTP status is a number, and says what to do.
      const status = isSolanaError(cause, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) ? ` (the RPC answered HTTP ${cause.context.statusCode})` : "";
      throw new NetworkIdentityError(
        `Cannot verify the Solana network${status}. Check the RPC connection and try again.`,
      );
    }
    if (actual !== expected) {
      throw new NetworkIdentityError(
        `The RPC is connected to a different network. Expected ${network}; the blockchain action was stopped.`,
      );
    }
    verifiedAt = Date.now();
  };

  return async function assertNetwork(signal?: AbortSignal): Promise<void> {
    if (verifiedAt !== null && Date.now() - verifiedAt < cacheMs) return;
    signal?.throwIfAborted();
    if (!pending) {
      // Cleared once it settles (before any waiter resumes), so a failed
      // check is never cached.
      const current: Promise<void> = Promise.resolve()
        .then(check)
        .finally(() => {
          if (pending === current) pending = null;
        });
      pending = current;
    }
    const shared = pending;
    if (!signal) return shared;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      shared.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  };
}

/** Keep the synchronous RPC factory API while gating every server request. */
export function createNetworkVerifiedRpc(
  url: string,
  network: Network,
  expectedHash?: string,
) {
  const rawTransport = createDefaultRpcTransport({ url });
  const rawRpc = createSolanaRpcFromTransport(rawTransport);
  const assertNetwork = createNetworkVerifier(rawRpc, network, {
    expectedHash,
    cacheMs: 30_000,
  });
  const transport: RpcTransport = async (config) => {
    // The request's own abort signal also bounds the genesis wait.
    await assertNetwork(config.signal);
    config.signal?.throwIfAborted();
    return rawTransport(config);
  };
  return createSolanaRpcFromTransport(transport);
}
