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

/** The wallet's KycEntry PDAs (one per registry) that are live at `commitment`. */
async function liveEntryPdas(
  rpc: ReturnType<typeof getServerRpc>,
  entryPdas: Address[],
  nowSec: number,
  commitment: "confirmed" | "finalized",
): Promise<Address[]> {
  const live: Address[] = [];
  for (const entryPda of entryPdas) {
    const entry = await fetchMaybeKycEntry(rpc, entryPda, {
      commitment,
      abortSignal: AbortSignal.timeout(12_000),
    });
    if (!entry.exists) continue;
    if (entry.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS) throw new Error("Unexpected KYC entry owner");
    if (entry.data.status === KycStatus.Approved && Number(entry.data.expiry) > nowSec) live.push(entryPda);
  }
  return live;
}

/**
 * Is `wallet`'s live passport FINALIZED (sim gap G1: a passport request may
 * be marked approved only for a passport that exists)? The /admin/kyc issue
 * flow marks the request approved right after its approve_holder CONFIRMED
 * on the BROWSER's RPC, ~15 s before that block is finalized, so this waits
 * for finality rather than refusing every normal issue:
 *   - "none": no live entry at confirmed, after `noneAttempts` reads
 *     `noneIntervalMs` apart (default 5 × 1 s): the server's RPC may be a
 *     slot or two behind the browser's, so a passport issued a moment ago
 *     gets that grace before the route says nothing was issued;
 *   - "finalized": a live entry is visible at finalized;
 *   - "not-finalized": live at confirmed, still not at finalized after
 *     `timeoutMs` (the caller asks to retry).
 * THROWS on any RPC or decode failure, like walletHasLivePassport.
 */
export async function passportFinality(
  wallet: string,
  opts: {
    nowSec?: number;
    timeoutMs?: number;
    intervalMs?: number;
    noneAttempts?: number;
    noneIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<"none" | "finalized" | "not-finalized"> {
  if (!BASE58_RE.test(wallet)) throw new Error("Not a wallet address");
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const noneAttempts = Math.max(1, opts.noneAttempts ?? 5);
  const noneIntervalMs = opts.noneIntervalMs ?? 1_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const rpc = getServerRpc();
  await createNetworkVerifier(rpc, detectNetwork())();
  const registries = await listKycRegistries(rpc);
  const pdas: Address[] = [];
  for (const record of registries) {
    const [entryPda] = await findKycEntryPda({ kycRegistry: record.address, holder: wallet as Address });
    pdas.push(entryPda);
  }
  let confirmed: Address[] = [];
  for (let attempt = 1; attempt <= noneAttempts; attempt++) {
    confirmed = await liveEntryPdas(rpc, pdas, nowSec, "confirmed");
    if (confirmed.length > 0 || attempt === noneAttempts) break;
    await sleep(noneIntervalMs);
  }
  if (confirmed.length === 0) return "none";
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await liveEntryPdas(rpc, confirmed, nowSec, "finalized")).length > 0) return "finalized";
    if (Date.now() + intervalMs > deadline) return "not-finalized";
    await sleep(intervalMs);
  }
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
