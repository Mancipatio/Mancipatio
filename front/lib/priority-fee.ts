// The one priority-fee point (Talas 4.2, design-4.2-4.3 §2.2).
//
// Only lib/verified-solana-client sets `computeUnitPrice` on wallet sends,
// through priceForRequest; the co-signed envelopes (issuer recovery, KYC
// registry creation) fix their price with resolveComputeUnitPrice when the
// document is prepared. A source-scan test (tests/single-fee-point) keeps it
// that way.
//
// The price comes from GET /api/priority-fee (the server asks its own RPC for
// getPriorityFeeEstimate when that RPC supports it, and answers the floor
// otherwise), and is ALWAYS clamped here to the network policy's
// [floor, cap], whatever the server returned. When the oracle is slow, down
// or answers anything unexpected, the floor is used: a send is never blocked
// by the fee. Isomorphic: outside a browser it answers the floor without a
// request.
import type { Address, Instruction } from "@solana/kit";
import {
  MAX_COMPUTE_UNIT_PRICE,
  SEND_OVERHEAD_INSTRUCTIONS,
  TRANSACTION_SIZE_LIMIT,
  decodeComputeBudgetInstruction,
  transactionSize,
} from "@/lib/compute-budget";
import type { Network } from "@/lib/network";

/** Helius priority levels (getPriorityFeeEstimate); "High" is about the 75th percentile. */
export type FeeLevel = "Medium" | "High" | "VeryHigh";
export type FeePolicy = { mode: "oracle" | "fixed"; floor: bigint; cap: bigint; level: FeeLevel };

/**
 * Per network, in micro-lamports per compute unit (D1). Testnet and localnet
 * are fixed at an explicit 0, so their transaction sizes stay deterministic.
 */
export const PRIORITY_FEE_POLICY: Readonly<Record<Network, FeePolicy>> = Object.freeze({
  mainnet: { mode: "oracle", floor: BigInt(100_000), cap: BigInt(2_000_000), level: "High" },
  devnet: { mode: "oracle", floor: BigInt(1_000), cap: BigInt(100_000), level: "High" },
  testnet: { mode: "fixed", floor: BigInt(0), cap: BigInt(0), level: "High" },
  localnet: { mode: "fixed", floor: BigInt(0), cap: BigInt(0), level: "High" },
});

/** Every policy must stay inside the hard cap; checked at module load (and by a test). */
export function assertFeePolicies(policies: Readonly<Record<string, FeePolicy>>): void {
  for (const [network, policy] of Object.entries(policies)) {
    if (policy.floor < BigInt(0) || policy.floor > policy.cap || policy.cap > MAX_COMPUTE_UNIT_PRICE) {
      throw new Error(`Priority fee policy for ${network} is outside 0 <= floor <= cap <= ${MAX_COMPUTE_UNIT_PRICE}`);
    }
  }
}
assertFeePolicies(PRIORITY_FEE_POLICY);

/** null → the floor; otherwise min(max(v, floor), cap), never above MAX_COMPUTE_UNIT_PRICE. */
export function clampComputeUnitPrice(value: bigint | null, policy: FeePolicy): bigint {
  const cap = policy.cap < MAX_COMPUTE_UNIT_PRICE ? policy.cap : MAX_COMPUTE_UNIT_PRICE;
  const floor = policy.floor < cap ? policy.floor : cap;
  if (value === null) return floor;
  if (value < floor) return floor;
  if (value > cap) return cap;
  return value;
}

/** How long a resolved price is reused per network. */
export const PRICE_CACHE_MS = 10_000;
/** How long the browser waits for /api/priority-fee before using the floor. */
export const ORACLE_TIMEOUT_MS = 2_000;
const MICRO_LAMPORTS_RE = /^\d{1,20}$/;

const cache = new Map<Network, { at: number; price: bigint }>();
const inflight = new Map<Network, Promise<bigint>>();

/** Drops the cached prices (tests; a network switch reloads the page anyway). */
export function resetPriorityFeeCache(): void {
  cache.clear();
  inflight.clear();
}

async function fetchOraclePrice(network: Network, policy: FeePolicy): Promise<bigint> {
  try {
    const res = await fetch("/api/priority-fee", {
      cache: "no-store",
      signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ORACLE_TIMEOUT_MS) : undefined,
    });
    if (!res.ok) throw new Error("status");
    const body = (await res.json()) as { ok?: unknown; network?: unknown; microLamports?: unknown } | null;
    if (
      !body || body.ok !== true || body.network !== network ||
      typeof body.microLamports !== "string" || !MICRO_LAMPORTS_RE.test(body.microLamports)
    ) {
      throw new Error("shape");
    }
    return clampComputeUnitPrice(BigInt(body.microLamports), policy);
  } catch {
    // No detail: a response body or error text is never echoed.
    console.warn("[priority-fee] the fee oracle is unavailable; using the network floor");
    return policy.floor;
  }
}

/**
 * The compute-unit price for a transaction on `network`, clamped to its
 * policy. Fixed networks answer the floor; oracle networks read
 * /api/priority-fee (2 s timeout), shared by concurrent callers and reused
 * for 10 s. Never rejects except when `signal` aborts.
 */
export async function resolveComputeUnitPrice(network: Network, signal?: AbortSignal): Promise<bigint> {
  const policy = PRIORITY_FEE_POLICY[network];
  if (!policy) throw new Error(`Unknown network ${String(network)}`);
  signal?.throwIfAborted();
  if (policy.mode === "fixed" || typeof window === "undefined") return clampComputeUnitPrice(null, policy);
  const hit = cache.get(network);
  if (hit && Date.now() - hit.at < PRICE_CACHE_MS) return clampComputeUnitPrice(hit.price, policy);
  let pending = inflight.get(network);
  if (!pending) {
    const run: Promise<bigint> = fetchOraclePrice(network, policy)
      .then((price) => {
        cache.set(network, { at: Date.now(), price });
        return price;
      })
      .finally(() => {
        if (inflight.get(network) === run) inflight.delete(network);
      });
    inflight.set(network, run);
    pending = run;
  }
  const price = signal
    ? await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      ])
    : await pending;
  return clampComputeUnitPrice(price, policy);
}

type PriceRequest = {
  computeUnitPrice?: bigint | number;
  instructions: readonly Instruction[];
};

/**
 * The price the verified client sets on `request`, or undefined when adding
 * SetComputeUnitPrice would push the transaction over the packet limit (it
 * is then sent without one, as before). Callers never set their own price:
 * a request carrying `computeUnitPrice` or a SetComputeUnitPrice instruction
 * is refused.
 */
export async function priceForRequest(
  network: Network,
  feePayer: Address,
  request: PriceRequest,
): Promise<bigint | undefined> {
  if (request.computeUnitPrice !== undefined) {
    throw new Error("The priority fee is set by the app; remove computeUnitPrice from this request.");
  }
  for (const ix of request.instructions) {
    if (decodeComputeBudgetInstruction(ix)?.kind === "price") {
      throw new Error("The priority fee is set by the app; remove the SetComputeUnitPrice instruction from this request.");
    }
  }
  let size: number;
  try {
    size = transactionSize(feePayer, [...SEND_OVERHEAD_INSTRUCTIONS, ...request.instructions]);
  } catch {
    // Not measurable here (the SDK reports the real problem): no price, as before.
    return undefined;
  }
  if (size > TRANSACTION_SIZE_LIMIT) return undefined;
  return resolveComputeUnitPrice(network);
}
