// 2D tombstone, shared by the ops scripts. `reclaim_rent` shrinks a retired
// Offer / OtcDeal / CustodyVault to exactly these 8 bytes and keeps it owned
// by asset_registry, so its PDA can never be re-created. Mirrors
// CLOSED_ACCOUNT_TAG in program/programs/asset_registry/src/constants.rs and
// front/lib/closed-account.ts (tests/closed-account-tag-ops.test.ts pins both).
export const CLOSED_ACCOUNT_TAG = Buffer.from('CLOSED__', 'utf8');

/** True for an asset_registry-owned account that is exactly the tombstone. */
export function isRegistryTombstone(owner, registryId, data) {
  return owner === registryId && data.length === CLOSED_ACCOUNT_TAG.length && Buffer.from(data).equals(CLOSED_ACCOUNT_TAG);
}
