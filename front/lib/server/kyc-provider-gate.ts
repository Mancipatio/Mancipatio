// SERVER-ONLY — on-chain KYC-provider authorization for signed routes.
//
// The KYC provider is `KycRegistry.authority`, NOT `Platform.admin`: the
// program seeds the registry with the original provider key and gates
// approve_holder / revoke_holder on that key alone, so rotating the platform
// admin neither moves the registry nor grants the new admin any passport
// rights (e2e §5). Routes that mirror a passport transaction into the
// off-chain dossier must therefore authorize against the registry authority
// — a rotated provider that is no longer the super admin still has to be
// able to write back (and retry) the sync for the transactions only it can
// send, and a new super admin who never held the registry must not.
//
// Usage (after verifySigned):
//   await requireKycProvider(wallet);         // 403 unless wallet === registry.authority
//   await requireAdminOrKycProvider(wallet);  // 403 unless admin/super admin OR provider
//
// Same stance as lib/server/admin-gate.ts: finalized reads on every request
// (no positive cache), fail closed (503) when the chain cannot be consulted.

import "server-only";

import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  fetchMaybePlatform,
  findPlatformPda,
} from "@/lib/generated/asset_registry";
import { kycGates, listKycRegistries, selectKycRegistry } from "@/lib/kyc-authority";
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

  // listKycRegistries (shared with the client) scans at "confirmed" and
  // verifies owner + discriminator. That is acceptable for authorization
  // here: a registry's authority is immutable once the account exists (no
  // rotation instruction), so the only thing commitment changes is how soon
  // a freshly created registry is honoured — never WHO its authority is.
  // selectKycRegistry keeps the two roles separate (the registry whose
  // authority is the platform admin wins only as a tie-break).
  const registries = await listKycRegistries(rpc);
  const { registry, ambiguous } = selectKycRegistry(registries, platformAdmin);
  const registryAuthority = registry ? registry.registry.authority.toString() : null;
  const { isKycProvider } = kycGates(wallet, registryAuthority, platformAdmin);
  return { isKycProvider, registryAuthority, ambiguous };
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
  if (!status.isKycProvider) {
    throw new SiwsError(403, "KYC provider privileges required");
  }
}

/**
 * Require the wallet to be a platform admin / super admin OR the KYC provider.
 * For the passport-request triage routes: the queue is an admin surface, but
 * a rotated provider — the only key that can still decide those requests
 * on-chain — must not be locked out of stamping its own decisions. A 503 from
 * either check propagates (fail closed); only a clean 403 falls through to
 * the other role.
 */
export async function requireAdminOrKycProvider(wallet: string): Promise<void> {
  try {
    await requireAdmin(wallet);
    return;
  } catch (err) {
    if (!(err instanceof SiwsError) || err.status !== 403) throw err;
  }
  try {
    await requireKycProvider(wallet);
  } catch (err) {
    if (err instanceof SiwsError && err.status === 403) {
      throw new SiwsError(403, "Admin or KYC provider privileges required");
    }
    throw err;
  }
}
