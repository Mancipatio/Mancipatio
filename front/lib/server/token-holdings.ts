// SERVER-ONLY — on-chain holdings verification for signed routes.
//
// Used by /api/resell/create to close the spoof hole: a seller can only list
// what their wallet actually holds, and the claimed share-class PDA must be
// the real ShareClass account behind the mint.
//
// Both checks FAIL CLOSED on RPC trouble (SiwsError 503) — never accept an
// unverifiable claim.

import "server-only";

import { type Address } from "@solana/kit";
import {
  AssetType,
  fetchMaybeAsset,
  fetchMaybeShareClass,
  VaultState,
} from "@/lib/generated/asset_registry";
import { fetchMaybeLiveCustodyVault } from "@/lib/closed-account";
import { SiwsError } from "@/lib/server/siws";
import { getServerRpc } from "@/lib/server/rpc";

const TOKEN_2022_PROGRAM =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

// Network-aware server RPC (see lib/server/rpc.ts) — holdings/vault checks that
// gate signed routes must run against the same cluster as the site.
const getRpc = getServerRpc;

/**
 * Total Token-2022 balance (base units) the owner holds of the given mint,
 * summed across all their token accounts. Throws SiwsError(503) when the RPC
 * is unreachable — callers must not treat that as "zero balance".
 */
export async function getToken2022Balance(
  owner: string,
  mint: string,
): Promise<bigint> {
  let res;
  try {
    res = await getRpc()
      .getTokenAccountsByOwner(
        owner as Address,
        { programId: TOKEN_2022_PROGRAM },
        { encoding: "jsonParsed" },
      )
      .send();
  } catch (err) {
    console.error("[token-holdings] RPC failure:", err);
    throw new SiwsError(503, "On-chain balance check unavailable — try again");
  }
  let total = BigInt(0);
  for (const item of res.value ?? []) {
    // jsonParsed shape: account.data.parsed.info.{ mint, tokenAmount: { amount } }
    const data = item.account?.data as unknown;
    if (!data || typeof data !== "object" || !("parsed" in data)) continue;
    const parsed = (
      data as {
        parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } };
      }
    ).parsed;
    const info = parsed?.info;
    if (info?.mint !== mint || !info?.tokenAmount?.amount) continue;
    total += BigInt(info.tokenAmount.amount);
  }
  return total;
}

/**
 * Whether the custody vault at `vaultPda` still holds the escrow on-chain.
 *
 * True for `Active` AND `Triggered`: triggering only arms the vault for
 * realisation, it moves nothing — the units are still escrowed. Treating
 * `Triggered` as settled let a caller mark a delivery request "returned" while
 * the tokens were still in the escrow.
 *
 * False when the vault no longer exists or has reached a state where the
 * escrow has been settled (Realized / Reverted / Returned / Expired). Note
 * that `Returned` can now be reached with a withheld surplus still in the
 * escrow — that surplus belongs to the KYC-gated follow-up return, not to this
 * check, whose question is only "has the holder's own deposit been released".
 *
 * Throws SiwsError(503) on RPC failure (fail closed) so callers never treat an
 * unverifiable vault as settled.
 */
export async function custodyVaultIsActive(vaultPda: string): Promise<boolean> {
  let account;
  try {
    account = await fetchMaybeLiveCustodyVault(getRpc(), vaultPda as Address);
  } catch (err) {
    console.error("[token-holdings] custody vault fetch failure:", err);
    throw new SiwsError(503, "On-chain vault check unavailable — try again");
  }
  if (!account.exists) return false;
  const state = account.data.state;
  return state === VaultState.Active || state === VaultState.Triggered;
}

/**
 * Require the on-chain ShareClass account at `shareClassPda` to exist and
 * reference exactly `mint`. Throws SiwsError(400) on mismatch, SiwsError(503)
 * on RPC failure (fail closed).
 */
export async function verifyShareClassMint(
  shareClassPda: string,
  mint: string,
): Promise<void> {
  let account;
  try {
    account = await fetchMaybeShareClass(getRpc(), shareClassPda as Address);
  } catch (err) {
    console.error("[token-holdings] share-class fetch failure:", err);
    throw new SiwsError(
      503,
      "On-chain share-class check unavailable — try again",
    );
  }
  if (!account.exists || account.data.mint.toString() !== mint) {
    throw new SiwsError(
      400,
      "share_class_pda does not match an on-chain share class for this mint",
    );
  }
}

export type ShareClassAssetFacts = {
  /** The share class's parent Asset PDA (from the on-chain account). */
  assetPda: string;
  /** Server-derived display label `<name> · #<classIndex> · <assetId>` —
   *  same shape the portfolio pages build, but from the CHAIN, so an admin
   *  queue can never be fed a spoofed "Premium Tower A" label. */
  assetLabel: string;
  /** The on-chain conversion target recorded by `set_convertible_to`
   *  (platform + issuer double gate), as an address string — `null` when the
   *  share class has none. This is the authoritative convertibility signal:
   *  the v2 flows document records the target per share class, and it works
   *  for every convertible structure (equity, real-estate ownership,
   *  convertible revenue share, …) regardless of category. */
  convertibleTo: string | null;
  /** Whether the on-chain AssetType is a deliverable category
   *  (Commodity / PhysicalGood). Callers may still admit admin-published
   *  profile reclassifications on top. */
  assetTypeDeliverable: boolean;
};

/**
 * Resolve `share_class_pda` → on-chain ShareClass → parent Asset. Verifies
 * the claimed mint is the class's real mint and derives the asset facts from
 * the on-chain records — holder-supplied labels are never trusted. Throws
 * SiwsError(400) on mismatch / missing accounts, SiwsError(503) on RPC
 * failure (fail closed).
 */
export async function resolveShareClassAssetFacts(
  shareClassPda: string,
  mint: string,
): Promise<ShareClassAssetFacts> {
  let shareClass;
  let asset;
  try {
    shareClass = await fetchMaybeShareClass(getRpc(), shareClassPda as Address);
    if (shareClass.exists) {
      asset = await fetchMaybeAsset(getRpc(), shareClass.data.asset);
    }
  } catch (err) {
    console.error("[token-holdings] share-class/asset fetch failure:", err);
    throw new SiwsError(
      503,
      "On-chain share-class check unavailable — try again",
    );
  }
  if (!shareClass.exists || shareClass.data.mint.toString() !== mint) {
    throw new SiwsError(
      400,
      "share_class_pda does not match an on-chain share class for this mint",
    );
  }
  if (!asset?.exists) {
    throw new SiwsError(400, "share class has no on-chain asset record");
  }
  const a = asset.data;
  return {
    assetPda: shareClass.data.asset.toString(),
    assetLabel: `${a.name} · #${shareClass.data.classIndex} · ${a.assetId}`,
    convertibleTo:
      shareClass.data.convertibleTo.__option === "Some"
        ? shareClass.data.convertibleTo.value.toString()
        : null,
    assetTypeDeliverable:
      a.assetType === AssetType.Commodity ||
      a.assetType === AssetType.PhysicalGood,
  };
}
