import {
  fetchEncodedAccount,
  type Account,
  type Address,
  type FetchAccountConfig,
} from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  decodeCustodyVault,
  OfferStatus,
  type CustodyVault,
} from "@/lib/generated/asset_registry";

/**
 * 2D tombstone. `reclaim_rent` shrinks a retired Offer / OtcDeal /
 * CustodyVault to exactly these 8 bytes, keeps it owned by the registry and
 * rent-exempt, so its PDA can never be re-created. Mirrors
 * `CLOSED_ACCOUNT_TAG` in `program/programs/asset_registry/src/constants.rs`.
 */
export const CLOSED_ACCOUNT_TAG: Uint8Array = new TextEncoder().encode(
  "CLOSED__",
);

/** True for a registry-owned account that is exactly the 8-byte tombstone. */
export function isClosedAccount(
  owner: string | null | undefined,
  data: Uint8Array | null | undefined,
): boolean {
  return (
    owner === ASSET_REGISTRY_PROGRAM_ADDRESS &&
    !!data &&
    data.length === CLOSED_ACCOUNT_TAG.length &&
    CLOSED_ACCOUNT_TAG.every((byte, index) => data[index] === byte)
  );
}

/** A `MaybeAccount` that also says whether a missing account is a tombstone. */
export type LiveMaybeAccount<T extends object, TAddress extends string = string> =
  | (Account<T, TAddress> & { exists: true; closed: false })
  | { address: Address<TAddress>; exists: false; closed: boolean };

type Rpc = Parameters<typeof fetchEncodedAccount>[0];

/**
 * Like Codama's `fetchMaybeCustodyVault`, which THROWS on 8-byte data: a
 * tombstoned vault (rent reclaimed after settlement) reads as
 * `{ exists: false, closed: true }`, a never-created one as
 * `{ exists: false, closed: false }`.
 */
export async function fetchMaybeLiveCustodyVault<
  TAddress extends string = string,
>(
  rpc: Rpc,
  vault: Address<TAddress>,
  config?: FetchAccountConfig,
): Promise<LiveMaybeAccount<CustodyVault, TAddress>> {
  const encoded = await fetchEncodedAccount(rpc, vault, config);
  if (!encoded.exists) return { address: vault, exists: false, closed: false };
  if (isClosedAccount(encoded.programAddress, encoded.data))
    return { address: vault, exists: false, closed: true };
  const decoded = decodeCustodyVault(encoded);
  return { ...decoded, exists: true, closed: false };
}

/**
 * Archived (rent-reclaimed) offers that may be merged into a live offer list.
 *
 * The 0069 trigger archives the LAST row the indexer mirrored, not the
 * offer's terminal state. The Offer arm is a permissionless crank, so
 * `take/expire/cancel_offer` + `reclaim_rent` can land in one transaction (or
 * the reclaim can finalize before the indexer job of the terminal
 * transaction): the archive then still says `Open`. Its real outcome is
 * unknown, so such a row is dropped — it must never be listed as takeable or
 * counted as open. Live rows win on a duplicate `${shareClass}-${offerId}`.
 */
export function mergeableArchivedOffers<
  T extends { shareClass: { toString(): string }; offerId: bigint; status: OfferStatus },
>(live: readonly T[], archived: readonly T[]): T[] {
  const liveKeys = new Set(live.map((o) => `${o.shareClass}-${o.offerId}`));
  return archived.filter(
    (o) =>
      o.status !== OfferStatus.Open && !liveKeys.has(`${o.shareClass}-${o.offerId}`),
  );
}
