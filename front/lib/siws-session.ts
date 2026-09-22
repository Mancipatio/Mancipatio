// Read-only actions a wallet session may authorize without a fresh signature.
// Shared by the client (lib/siws-client.ts) and the server (lib/server/siws.ts).
// Anything that writes, moves value, changes identity or grants access keeps
// requiring a per-request wallet signature — never add such an action here.

export const SESSION_COOKIE = "manci_session";

/** How long one "sign in" lasts before the wallet is asked again. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export const SESSION_READ_ACTIONS: ReadonlySet<string> = new Set([
  "account.me",
  "account.wallets.transaction",
  "adminConfig.raiseLimitsRead",
  "adminConfig.read",
  "applications.adminEvents",
  "applications.adminList",
  "applications.capacity",
  "applications.mine",
  "audit.list",
  "clients.adminDetail",
  "clients.adminList",
  "clients.doc-url",
  "clients.lookup",
  "clients.me",
  "compliance.list",
  "conversion.adminList",
  "conversion.listMine",
  "delivery.adminList",
  "delivery.listMine",
  "distribution-plans.adminRead",
  "distribution-plans.proof",
  "fees.list",
  "inquiries.list",
  "issuer-profiles.read",
  "otc.adminScreen",
  "otc.list",
  "passport.list",
  "payout-snapshots.adminRead",
  "payout-snapshots.proof",
  "profiles.read",
  "storage.documents.list",
  "vesting-series.admin-list",
  "vesting-series.creation-state",
  "vesting-series.list-mine",
  "vesting.beneficiaries",
]);

export function isSessionReadAction(action: string): boolean {
  return SESSION_READ_ACTIONS.has(action);
}
