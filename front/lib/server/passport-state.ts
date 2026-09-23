// SERVER-ONLY — does a wallet still hold a live on-chain KYC passport?
//
// Used by /api/clients/anonymize: erasing a dossier while the chain still
// vouches for its wallet (KycEntry Approved and not expired) would leave a
// verified holder with no identity evidence kept anywhere. The passport must
// be revoked first (admin client page, KYC provider).
//
// Every KycRegistry on-chain is checked (normally exactly one), so an
// ambiguous registry set cannot hide a live entry. Reads at "confirmed" — the
// freshest view, so a passport issued seconds ago still blocks. FAIL CLOSED:
// any RPC / decode failure throws, and the caller refuses (503).

import "server-only";

import type { Address } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  KycStatus,
  fetchMaybeKycEntry,
  findKycEntryPda,
} from "@/lib/generated/asset_registry";
import { listKycRegistries } from "@/lib/kyc-authority";
import { getServerRpc } from "@/lib/server/rpc";
import { SiwsError } from "@/lib/server/siws-error";
import { createNetworkVerifier } from "@/lib/network-identity";
import { detectNetwork } from "@/lib/network";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * True when `wallet` holds an Approved, unexpired KycEntry in any registry.
 * `expiry <= now` counts as expired (expiry 0 always is), as on-chain.
 * THROWS on any RPC or decode failure — never "assume none".
 */
export async function walletHasLivePassport(
  wallet: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!BASE58_RE.test(wallet)) throw new Error("Not a wallet address");
  const rpc = getServerRpc();
  // The endpoint must still match the requested cluster.
  await createNetworkVerifier(rpc, detectNetwork())();
  const registries = await listKycRegistries(rpc);
  for (const record of registries) {
    const [entryPda] = await findKycEntryPda({ kycRegistry: record.address, holder: wallet as Address });
    const entry = await fetchMaybeKycEntry(rpc, entryPda, {
      commitment: "confirmed",
      abortSignal: AbortSignal.timeout(12_000),
    });
    if (!entry.exists) continue;
    if (entry.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS) throw new Error("Unexpected KYC entry owner");
    if (entry.data.status === KycStatus.Approved && Number(entry.data.expiry) > nowSec) return true;
  }
  return false;
}

/**
 * Refuse (409) while `wallet` holds a live passport; 503 when the chain could
 * not be consulted. A dossier without a wallet has no passport to check.
 */
export async function assertNoLivePassport(wallet: string | null | undefined): Promise<void> {
  if (!wallet) return;
  let live: boolean;
  try {
    live = await walletHasLivePassport(wallet);
  } catch (err) {
    console.error("[passport-state] on-chain passport check failed:", err instanceof Error ? err.message : String(err));
    throw new SiwsError(503, "Could not check the on-chain passport — nothing was changed; try again");
  }
  if (live) {
    throw new SiwsError(
      409,
      "This client's wallet still holds a live on-chain passport. Revoke it first, then erase the dossier — nothing was changed.",
    );
  }
}
