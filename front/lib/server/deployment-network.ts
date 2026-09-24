// SERVER-ONLY — the deployment-network assertion both worker leases run
// (migration 0072 public.assert_deployment_network, on 0070's identity).
// The same rule as the 0071 guard and /api/health's databaseNetwork check:
// equal networks, or both non-mainnet.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { detectNetwork, type Network } from "@/lib/network";

export class DeploymentNetworkError extends Error {
  constructor() {
    super("Deployment network mismatch");
    this.name = "DeploymentNetworkError";
  }
}

/** A lease or assertion error that means "this database serves another network" (or has no identity). */
export function isDeploymentNetworkError(error: { code?: unknown; message?: unknown } | null | undefined): boolean {
  if (!error) return false;
  const message = typeof error.message === "string" ? error.message : "";
  return message.startsWith("DEPLOYMENT_NETWORK_MISMATCH") || error.code === "55000"
    || (error.code === "23514" && /does not belong to this/.test(message));
}

/** Resolves when the database serves this deployment's network; throws
 * DeploymentNetworkError on a mismatch, Error when the database is unreachable. */
export async function assertDeploymentNetwork(sb: SupabaseClient, signal?: AbortSignal): Promise<Network> {
  const network = detectNetwork();
  let query = sb.rpc("assert_deployment_network", { p_network: network });
  if (signal) query = query.abortSignal(signal);
  const { error } = await query;
  if (isDeploymentNetworkError(error)) throw new DeploymentNetworkError();
  if (error) throw new Error("Deployment network check unavailable");
  return network;
}
