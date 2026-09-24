// SERVER-ONLY — on-chain KYC-provider authorization for signed routes.
//
// The KYC provider is `KycRegistry.authority`, NOT `Platform.admin`: the
// program gates approve_holder / revoke_holder on that key alone. Rotating
// the platform admin neither moves the registry nor grants the new admin any
// passport rights (e2e §5), and rotating the registry authority
// (propose/accept) moves those rights without moving the registry address. Routes that mirror a passport transaction into the
// off-chain dossier must therefore authorize against the registry authority
// — a rotated provider that is no longer the super admin still has to be
// able to write back (and retry) the sync for the transactions only it can
// send, and a new super admin who never held the registry must not.
//
// Usage (after verifySigned):
//   await requireKycProvider(wallet);         // 403 unless wallet === registry.authority
//   const role = await requireAdminOrKycProvider(wallet);
//     // 403 unless admin/super admin OR provider; role = "admin" | "kycProvider"
//
// Same stance as lib/server/admin-gate.ts: finalized reads on every request
// (no positive cache), fail closed (503) when the chain cannot be consulted.

import "server-only";

import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  fetchMaybePlatform,
  findPlatformPda,
} from "@/lib/generated/asset_registry";
import type { Address } from "@solana/kit";
import {
  fetchKycRegistryAt,
  kycGates,
  listKycRegistries,
  selectKycRegistry,
} from "@/lib/kyc-authority";
import { configuredKycRegistry } from "@/lib/kyc-registry-pin";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getServerRpc } from "@/lib/server/rpc";
import { SiwsError } from "@/lib/server/siws";
import { createNetworkVerifier } from "@/lib/network-identity";
import { detectNetwork } from "@/lib/network";

export type KycProviderStatus = {
  /** Wallet equals the live `KycRegistry.authority`. */
  isKycProvider: boolean;
  /** The resolved registry authority, or null when no registry exists. */
  registryAuthority: string | null;
  /** More than one registry exists and none belongs to the platform admin. */
  ambiguous: boolean;
  /** NEXT_PUBLIC_KYC_REGISTRY is set but no registry exists at it. */
  pinnedMissing: boolean;
};

async function fetchKycProviderStatus(wallet: string): Promise<KycProviderStatus> {
  const rpc = getServerRpc();
  // The endpoint must still match the requested cluster.
  await createNetworkVerifier(rpc, detectNetwork())();

  const [platformPda] = await findPlatformPda();
  const platform = await fetchMaybePlatform(rpc, platformPda, {
    commitment: "finalized",
    abortSignal: AbortSignal.timeout(12_000),
  });
  if (platform.exists && platform.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS) {
    throw new Error("Unexpected platform account owner");
  }
  const platformAdmin = platform.exists ? platform.data.admin : null;

  // WHICH registry: the deployment pin (NEXT_PUBLIC_KYC_REGISTRY) wins, with
  // no scan and no fallback. A pin missing on-chain is a 403, never the
  // heuristic, and an invalid pin throws (503). With no pin,
  // listKycRegistries (shared with the client: "confirmed", owner and
  // discriminator verified) and selectKycRegistry keep the two roles
  // separate: the registry whose authority is the platform admin wins only
  // as a tie-break.
  const pinned = configuredKycRegistry();
  let chosen: Address | null;
  let ambiguous = false;
  if (pinned) {
    chosen = pinned;
  } else {
    const selection = selectKycRegistry(await listKycRegistries(rpc), platformAdmin);
    chosen = selection.registry?.address ?? null;
    ambiguous = selection.ambiguous;
  }

  // WHO the authority is comes from a FINALIZED re-read of the chosen
  // registry. `authority` rotates (propose/accept, 2C-1), so a rotation that
  // is confirmed but not yet finalized must not move write-back rights yet.
  // Owner, discriminator and length are re-verified.
  const registry = chosen ? await fetchKycRegistryAt(rpc, chosen, "finalized") : null;
  const pinnedMissing = pinned !== null && registry === null;
  const registryAuthority = registry ? registry.registry.authority.toString() : null;
  const { isKycProvider } = kycGates(wallet, registryAuthority, platformAdmin);
  return { isKycProvider, registryAuthority, ambiguous, pinnedMissing };
}

/**
 * Require the wallet to be THE KYC provider (`KycRegistry.authority`). Throws
 * SiwsError(403) otherwise — including when no registry exists or the live
 * registry cannot be chosen — and SiwsError(503) on RPC failure (fail closed;
 * never grant on error).
 */
export async function requireKycProvider(wallet: string): Promise<void> {
  let status: KycProviderStatus;
  try {
    status = await fetchKycProviderStatus(wallet);
  } catch (err) {
    console.error("[kyc-provider-gate] RPC failure while checking KYC provider:", err);
    throw new SiwsError(503, "Authorization check unavailable — try again");
  }
  if (status.ambiguous) {
    throw new SiwsError(
      403,
      "KYC registry authority could not be resolved — several registries exist",
    );
  }
  if (status.pinnedMissing) {
    throw new SiwsError(403, "The pinned KYC registry does not exist on this network");
  }
  if (!status.isKycProvider) {
    throw new SiwsError(403, "KYC provider privileges required");
  }
}

/** Which role let a wallet through requireAdminOrKycProvider. */
export type AdminOrKycRole = "admin" | "kycProvider";

/**
 * Require the wallet to be a platform admin / super admin OR the KYC provider,
 * and say which one passed. For the passport-request triage routes and the
 * client-dossier routes the KYC provider works on (Talas 3.1 K6): the queue is
 * an admin surface, but the provider — the only key that can decide those
 * requests on-chain — must not need an Admin record to do its job. Routes
 * that must stay narrower for a provider (never lifting a suspension or a
 * rejection) branch on the returned role. A 503 from either check propagates
 * (fail closed); only a clean 403 falls through to the other role.
 */
export async function requireAdminOrKycProvider(wallet: string): Promise<AdminOrKycRole> {
  try {
    await requireAdmin(wallet);
    return "admin";
  } catch (err) {
    if (!(err instanceof SiwsError) || err.status !== 403) throw err;
  }
  try {
    await requireKycProvider(wallet);
    return "kycProvider";
  } catch (err) {
    if (err instanceof SiwsError && err.status === 403) {
      throw new SiwsError(403, "Admin or KYC provider privileges required");
    }
    throw err;
  }
}
