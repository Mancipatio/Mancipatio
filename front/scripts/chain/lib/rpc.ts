/**
 * Genesis-pinned, method-allowlisted, throttled and scrubbed RPC transport
 * (design-3.3 §3.3). Every call first proves the genesis hash, then passes the
 * allowlist, then a token bucket. Reads retry up to 3 times on 429/5xx; every
 * failure surfaces as `ChainRpcError("RPC <method> failed; details withheld")`.
 */
import {
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  isSolanaError,
  type RpcTransport,
} from "@solana/kit";
import type { Network } from "@/lib/network";
import { createNetworkVerifier } from "@/lib/network-identity";
import { ChainAbortError, ChainGateError, ChainRpcError } from "./safety";

export const READ_METHODS = [
  "getGenesisHash",
  "getVersion",
  "getAccountInfo",
  "getMultipleAccounts",
  "getProgramAccounts",
  "getBalance",
  "getLatestBlockhash",
  "getBlockHeight",
  "getSlot",
  "getMinimumBalanceForRentExemption",
  "simulateTransaction",
  "getSignatureStatuses",
  "getRecentPrioritizationFees",
] as const;
export const SEND_METHODS = [...READ_METHODS, "sendTransaction"] as const;

export type RpcMode = "read" | "send";

export type ChainRpcOptions = {
  url: string;
  network: Network;
  /** Always a defined string: CHAIN_GENESIS_HASH (localnet) or the cluster hash. */
  expectedGenesis: string;
  mode: RpcMode;
  /** Requests per second (token bucket). `Infinity` disables throttling (tests). */
  rps: number;
  /** Deadline / interrupt signal; passed to every call of the main client. */
  signal?: AbortSignal;
  /** Injected transport (tests). Defaults to kit's HTTP transport. */
  transport?: RpcTransport;
  sleep?: (ms: number) => Promise<void>;
  /** Base retry delay in ms (attempt × this). */
  retryDelayMs?: number;
  /** Genesis verification cache; 0 re-verifies before every call. */
  genesisCacheMs?: number;
};

export type RpcCallRecord = { method: string; attempt: number; ok: boolean; code?: number | null };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function httpStatus(error: unknown): number | null {
  if (isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
    return error.context.statusCode;
  }
  return null;
}

function retryableJsonRpcCode(code: number | null): boolean {
  // -32005: node behind; -32004: block not available; 429 via some gateways.
  return code === -32005 || code === -32004 || code === 429;
}

function createTokenBucket(rps: number, sleep: (ms: number) => Promise<void>) {
  if (!Number.isFinite(rps)) return async () => {};
  let tokens = rps;
  let last = Date.now();
  return async function take(signal?: AbortSignal) {
    for (;;) {
      const now = Date.now();
      tokens = Math.min(rps, tokens + ((now - last) / 1000) * rps);
      last = now;
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      if (signal?.aborted) throw new ChainAbortError();
      await sleep(Math.ceil(((1 - tokens) / rps) * 1000));
    }
  };
}

function combineSignals(a?: AbortSignal | null, b?: AbortSignal | null): AbortSignal | undefined {
  if (a && b) return AbortSignal.any([a, b]);
  return a ?? b ?? undefined;
}

/**
 * Builds the guarded clients:
 * - `rpc`: every call carries the run's abort signal;
 * - `drainRpc`: the same guards without the run signal, used only to keep
 *   polling an in-flight signature after an abort (design §3.8).
 */
export function createChainRpc(options: ChainRpcOptions) {
  const allowed = new Set<string>(options.mode === "send" ? SEND_METHODS : READ_METHODS);
  const base = options.transport ?? createDefaultRpcTransport({ url: options.url });
  const sleep = options.sleep ?? defaultSleep;
  const retryDelayMs = options.retryDelayMs ?? 500;
  const take = createTokenBucket(options.rps, sleep);
  const calls: RpcCallRecord[] = [];

  const inner =
    (runSignal: AbortSignal | undefined): RpcTransport =>
    async <TResponse>(config: Parameters<RpcTransport>[0]): Promise<TResponse> => {
      const payload = config.payload as { method?: unknown } | undefined;
      const method = typeof payload?.method === "string" ? payload.method : "unknown";
      if (!allowed.has(method)) {
        throw new ChainGateError(`RPC method ${method} is not allowed in ${options.mode} mode`);
      }
      const signal = combineSignals(config.signal, runSignal);
      const maxAttempts = method === "sendTransaction" ? 1 : 3;
      for (let attempt = 1; ; attempt++) {
        if (signal?.aborted) throw new ChainAbortError();
        await take(signal);
        let retryable = false;
        let code: number | null = null;
        try {
          const response = (await base({ ...config, signal })) as {
            error?: { code?: unknown };
          };
          if (response && typeof response === "object" && response.error) {
            code = typeof response.error.code === "number" ? response.error.code : null;
            retryable = retryableJsonRpcCode(code);
          } else {
            calls.push({ method, attempt, ok: true });
            return response as TResponse;
          }
        } catch (error) {
          if (error instanceof ChainGateError) throw error;
          if (signal?.aborted) throw new ChainAbortError();
          code = httpStatus(error);
          retryable = code === null || code === 429 || code >= 500;
        }
        calls.push({ method, attempt, ok: false, code });
        if (!retryable || attempt >= maxAttempts) throw new ChainRpcError(method, code);
        await sleep(attempt * retryDelayMs);
      }
    };

  // The verifier keeps its own 10 s timeout and no run signal, so the drain
  // client can still prove the genesis after an abort.
  const verifierRpc = createSolanaRpcFromTransport(inner(undefined));
  const assertNetwork = createNetworkVerifier(verifierRpc, options.network, {
    expectedHash: options.expectedGenesis,
    cacheMs: options.genesisCacheMs ?? 15_000,
  });
  const guarded =
    (runSignal: AbortSignal | undefined): RpcTransport =>
    async <TResponse>(config: Parameters<RpcTransport>[0]): Promise<TResponse> => {
      await assertNetwork();
      return inner(runSignal)<TResponse>(config);
    };

  return {
    rpc: createSolanaRpcFromTransport(guarded(options.signal)),
    drainRpc: createSolanaRpcFromTransport(guarded(undefined)),
    assertNetwork,
    calls,
  };
}

export type ChainRpc = ReturnType<typeof createChainRpc>["rpc"];
export type ChainRpcClients = ReturnType<typeof createChainRpc>;
