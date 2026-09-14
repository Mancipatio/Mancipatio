// SERVER-ONLY — on-chain admin authorization for signed routes.
//
// The source of truth is the asset_registry program:
//   - super admin  = Platform PDA `.admin` field
//   - admin        = existence of the Admin PDA ["admin", wallet]
// (Mirrors the client-side useRole() in lib/auth.ts: super admin counts as
// admin.)
//
// Usage (after verifySigned):
//   await requireAdmin(wallet);        // throws SiwsError(403) if not admin
//   await requireSuperAdmin(wallet);   // throws SiwsError(403) if not super admin
//
// Read current finalized authority for every privileged request. A positive
// process cache must not extend a revoked operator's access.

import "server-only";

import { type Address } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  fetchMaybeAdmin,
  fetchMaybePlatform,
  findAdminRecordPda,
  findPlatformPda,
} from "@/lib/generated/asset_registry";
import { SiwsError } from "@/lib/server/siws";
import { getServerRpc } from "@/lib/server/rpc";
import { createNetworkVerifier } from "@/lib/network-identity";
import { detectNetwork } from "@/lib/network";

// Network-aware server RPC (mirrors the client's detectNetwork; fails closed on
// a mainnet deployment with no mainnet RPC configured) — admin authorization
// must never be evaluated against the wrong cluster.
const getRpc = getServerRpc;

type AdminStatus = { isAdmin: boolean; isSuperAdmin: boolean };
async function fetchAdminStatus(wallet: string): Promise<AdminStatus> {
  const rpc = getRpc();
  // The endpoint must still match the requested cluster.
  await createNetworkVerifier(rpc, detectNetwork())();

  const walletAddress = wallet as Address;

  const [platformPda] = await findPlatformPda();
  const platform = await fetchMaybePlatform(rpc, platformPda,{commitment:"finalized",abortSignal:AbortSignal.timeout(12_000)});
  if(platform.exists && platform.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS) throw new Error("Unexpected platform account owner");
  const isSuperAdmin =
    platform.exists && platform.data.admin.toString() === wallet;

  let isAdmin = isSuperAdmin;
  if (!isAdmin && platform.exists) {
    const [adminPda] = await findAdminRecordPda({ authority: walletAddress });
    const admin = await fetchMaybeAdmin(rpc, adminPda,{commitment:"finalized",abortSignal:AbortSignal.timeout(12_000)});
    isAdmin = admin.exists && admin.programAddress === ASSET_REGISTRY_PROGRAM_ADDRESS && admin.data.admin === wallet;
  }

  return {isAdmin,isSuperAdmin};
}

/**
 * Require the wallet to be a platform admin (Admin PDA exists) OR the super
 * admin. Throws SiwsError(403) otherwise; SiwsError(503) if the RPC is
 * unreachable (fail closed — never grant on error).
 */
export async function requireAdmin(wallet: string): Promise<void> {
  let status: AdminStatus;
  try {
    status = await fetchAdminStatus(wallet);
  } catch (err) {
    console.error("[admin-gate] RPC failure while checking admin:", err);
    throw new SiwsError(503, "Authorization check unavailable — try again");
  }
  if (!status.isAdmin) {
    throw new SiwsError(403, "Admin privileges required");
  }
}

/**
 * Require the wallet to be THE super admin (Platform.admin). Throws
 * SiwsError(403) otherwise; SiwsError(503) on RPC failure (fail closed).
 */
export async function requireSuperAdmin(wallet: string): Promise<void> {
  let status: AdminStatus;
  try {
    status = await fetchAdminStatus(wallet);
  } catch (err) {
    console.error("[admin-gate] RPC failure while checking super admin:", err);
    throw new SiwsError(503, "Authorization check unavailable — try again");
  }
  if (!status.isSuperAdmin) {
    throw new SiwsError(403, "Super admin privileges required");
  }
}
