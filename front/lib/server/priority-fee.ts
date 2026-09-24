// SERVER-ONLY — the priority-fee oracle behind GET /api/priority-fee
// (Talas 4.2, design-4.2-4.3 §2.3).
//
// getRecentPrioritizationFees is not a congestion signal for Manci: our
// accounts are uncontended and the per-block minimum is usually 0, so every
// percentile sits at the floor. This asks the server's own RPC for
// `getPriorityFeeEstimate` (the Helius API method: a cluster-wide estimate for
// transactions touching our two programs) instead. The oracle is provider
// agnostic: an RPC that does not implement the method (or any error, timeout
// or unexpected answer) gives the network floor, reported as source "floor".
// Helius is never required. Every answer is clamped to the network policy,
// and the browser clamps it again (lib/priority-fee).
//
// The RPC URL can carry a provider API key: it is never logged, and failures
// are logged as fixed reason codes only.

import "server-only";

import { ASSET_REGISTRY_PROGRAM_ADDRESS } from "@/lib/generated/asset_registry";
import { TRANSFER_HOOK_PROGRAM_ADDRESS } from "@/lib/generated/transfer_hook";
import type { Network } from "@/lib/network";
import {
  PRIORITY_FEE_POLICY,
  clampComputeUnitPrice,
  type FeeLevel,
} from "@/lib/priority-fee";
import { serverRpcEndpoint } from "@/lib/server/rpc";

export type PriorityFeeSource = "helius" | "floor";
export type PriorityFeeReading = {
  network: Network;
  microLamports: bigint;
  source: PriorityFeeSource;
  level: FeeLevel;
};

/** A reading is shared for this long per instance; concurrent callers share one request. */
export const PRIORITY_FEE_CACHE_MS = 5_000;
/** The RPC gets this long to answer before the floor is used. */
export const PRIORITY_FEE_RPC_TIMEOUT_MS = 1_200;

const cache = new Map<Network, { at: number; reading: PriorityFeeReading }>();
const inflight = new Map<Network, Promise<PriorityFeeReading>>();

/** Drops cached readings (tests). */
export function resetPriorityFeeReadings(): void {
  cache.clear();
  inflight.clear();
}

type Reason = "not_configured" | "network_mismatch" | "http" | "rpc_error" | "shape" | "unavailable";

function floorReading(network: Network, reason: Reason | null): PriorityFeeReading {
  const policy = PRIORITY_FEE_POLICY[network];
  // A fixed network has nothing to ask; everything else says why (a code only).
  if (reason) console.warn(`[priority-fee] no estimate (${reason}); using the network floor`);
  return { network, microLamports: clampComputeUnitPrice(null, policy), source: "floor", level: policy.level };
}

async function estimate(network: Network): Promise<PriorityFeeReading> {
  const policy = PRIORITY_FEE_POLICY[network];
  if (policy.mode === "fixed") return floorReading(network, null);
  let url: string;
  try {
    const endpoint = serverRpcEndpoint();
    if (endpoint.network !== network) return floorReading(network, "network_mismatch");
    url = endpoint.url;
  } catch {
    return floorReading(network, "not_configured");
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(PRIORITY_FEE_RPC_TIMEOUT_MS),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "manci-priority-fee",
        method: "getPriorityFeeEstimate",
        params: [
          {
            accountKeys: [ASSET_REGISTRY_PROGRAM_ADDRESS, TRANSFER_HOOK_PROGRAM_ADDRESS],
            options: { priorityLevel: policy.level },
          },
        ],
      }),
    });
    if (!res.ok) return floorReading(network, "http");
    const body = (await res.json()) as { error?: unknown; result?: { priorityFeeEstimate?: unknown } } | null;
    if (!body || typeof body !== "object") return floorReading(network, "shape");
    if (body.error !== undefined && body.error !== null) return floorReading(network, "rpc_error");
    const value = body.result?.priorityFeeEstimate;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return floorReading(network, "shape");
    return {
      network,
      microLamports: clampComputeUnitPrice(BigInt(Math.ceil(value)), policy),
      source: "helius",
      level: policy.level,
    };
  } catch {
    // Timeouts and transport errors alike: their text can carry the URL.
    return floorReading(network, "unavailable");
  }
}

/** The clamped priority fee for `network`, at most a few seconds old. Never throws. */
export async function readPriorityFee(network: Network): Promise<PriorityFeeReading> {
  const hit = cache.get(network);
  if (hit && Date.now() - hit.at < PRIORITY_FEE_CACHE_MS) return hit.reading;
  let pending = inflight.get(network);
  if (!pending) {
    const run: Promise<PriorityFeeReading> = estimate(network)
      .then((reading) => {
        cache.set(network, { at: Date.now(), reading });
        return reading;
      })
      .finally(() => {
        if (inflight.get(network) === run) inflight.delete(network);
      });
    inflight.set(network, run);
    pending = run;
  }
  return pending;
}
