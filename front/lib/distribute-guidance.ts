// Distribute guidance (components/distribute-card, send-to-wallets-panel,
// public-sale-panel): where Primary issuance (pause bit 0x02) is reopened,
// the order of "Both", and what the issuer does when an approved sale holds
// all the room left.
//
// 0x02 is reopened in two places:
//   · /admin/launchpad — the public sale requests, where the super admin runs
//     the pre-clear check of an APPROVED sale and reopens it for that sale
//     (app/admin/launchpad/pre-clear-check.tsx);
//   · /admin/platform — the emergency pause panel (components/
//     pause-flags-panel), for any other reason (a wallet list that must
//     create tokens with no sale on the way).
// Both pages are the operator's: the issuer sees where it happens, the
// owner (who may be both) gets there in one click.
//
// Pure and node-safe: tests/distribute-guidance.test.ts.
import { roomToCreate, type SupplyFacts } from "@/lib/distribution-supply";

/** Anchor of the public sale requests on /admin/launchpad (the pre-clear check lives in each approved request). */
export const PUBLIC_SALE_REQUESTS_ANCHOR = "public-sale-requests";
/** Anchor of the emergency pause panel on /admin/platform. */
export const EMERGENCY_PAUSE_ANCHOR = "emergency-pause";

export type ReopenPlace = { href: string; label: string };

export const REOPEN_AT_LAUNCHPAD: ReopenPlace = {
  href: `/admin/launchpad#${PUBLIC_SALE_REQUESTS_ANCHOR}`,
  label: "Admin → Launchpad: pre-clear check and reopen",
};

export const REOPEN_AT_PLATFORM: ReopenPlace = {
  href: `/admin/platform#${EMERGENCY_PAUSE_ANCHOR}`,
  label: "Admin → Platform: emergency pause panel",
};

/** Where 0x02 is reopened: the pre-clear check when a public sale of the class is approved (or requested), else the pause panel. */
export function primaryReopenPlace(input: { publicSale: boolean }): ReopenPlace {
  return input.publicSale ? REOPEN_AT_LAUNCHPAD : REOPEN_AT_PLATFORM;
}

/** "Both", in order. */
export const BOTH_MODE_STEPS: readonly string[] = [
  "Request the public sale (below) for the tokens the wallet list leaves.",
  "The operator approves it and reopens Primary issuance (0x02) after the pre-clear check.",
  "Send to the wallets: tokens the treasury lacks are created first, never out of the approved sale's share, and Primary issuance stays open for the sale.",
  "Open the sale.",
];

/** Said when the room left is 0 because an approved sale is not opened yet. */
export const APPROVED_SALE_HOLDS_ROOM = "Open the sale first (or decline it) — the approved tokens are reserved for it.";

/**
 * Whether the room left to create is 0 BECAUSE a sale of the class is
 * approved and not opened yet: without that approval there would be room.
 */
export function roomHeldByApprovedSale(f: SupplyFacts): boolean {
  const approved = f.approvedUnopened ?? BigInt(0);
  if (approved <= BigInt(0)) return false;
  const room = roomToCreate(f);
  if (room === null || room > BigInt(0)) return false;
  const without = roomToCreate({ ...f, approvedUnopened: BigInt(0) });
  return without === null || without > BigInt(0);
}
