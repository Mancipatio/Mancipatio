// Public identity for assets and sales in links and React list keys.
//
// The program allows two issuers to register the same `assetId` (the asset
// PDA is seeded by issuer + assetId), and two share classes of one asset can
// both have a sale #1 (the sale PDA is seeded by shareClass + saleId). Links
// and list keys built from the bare ids therefore open the first match instead
// of the intended record. Use the asset PDA as the public identity and the
// full shareClass+saleId key (or the sale PDA) for sales.
import type { Address } from "@solana/kit";
import { findAssetPda } from "@/lib/generated/asset_registry";

/** Base58 Solana address: 32–44 chars, no 0/O/I/l. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** True when the route param looks like an on-chain address (asset PDA). */
export function isAddressLike(param: string): boolean {
  return BASE58_ADDRESS.test(param);
}

/** Canonical public link for an asset, keyed by its PDA. */
export function assetHref(assetPda: string): string {
  return `/marketplace/assets/${encodeURIComponent(assetPda)}`;
}

/** Canonical public link for a sale, keyed by its PDA. */
export function saleHref(salePda: string | null | undefined): string {
  return salePda
    ? `/marketplace/launchpad/${encodeURIComponent(salePda)}`
    : "/marketplace/launchpad";
}

/** Stable list/map key for a sale: the full shareClass+saleId pair. */
export function saleKey(shareClass: { toString(): string }, saleId: bigint | number): string {
  return `${shareClass.toString()}:${String(saleId)}`;
}

/** Stable list key for a share class: asset PDA + class index. */
export function shareClassKey(asset: { toString(): string }, classIndex: number): string {
  return `${asset.toString()}:${classIndex}`;
}

export type AddressedAsset<A> = { asset: A; address: string };

/** Pair every asset with its PDA so lists can link and key by identity. */
export async function withAssetAddresses<
  A extends { issuer: Address; assetId: string },
>(assets: readonly A[]): Promise<AddressedAsset<A>[]> {
  return Promise.all(
    assets.map(async (asset) => {
      const [pda] = await findAssetPda({ issuer: asset.issuer, assetId: asset.assetId });
      return { asset, address: pda.toString() };
    }),
  );
}

export type AssetLookup<A> =
  | { kind: "found"; asset: A; address: string; legacy: boolean }
  | { kind: "ambiguous"; candidates: AddressedAsset<A>[] }
  | { kind: "missing" };

/**
 * Resolve the `[id]` route param to exactly one asset.
 *
 * The PDA is the identity. A bare `assetId` (legacy links, bookmarks) is only
 * honoured when it is unique across issuers; otherwise the caller must ask the
 * user to pick, never silently open the first match.
 */
export function resolveAssetParam<A extends { assetId: string }>(
  assets: readonly AddressedAsset<A>[],
  param: string,
): AssetLookup<A> {
  const byPda = assets.find((a) => a.address === param);
  if (byPda) return { kind: "found", asset: byPda.asset, address: byPda.address, legacy: false };
  const byId = assets.filter((a) => a.asset.assetId === param);
  if (byId.length === 1) {
    return { kind: "found", asset: byId[0].asset, address: byId[0].address, legacy: true };
  }
  if (byId.length > 1) return { kind: "ambiguous", candidates: byId };
  return { kind: "missing" };
}
