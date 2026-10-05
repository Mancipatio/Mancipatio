// Read-only actions a wallet session may authorize without a fresh signature.
// Shared by the client (lib/siws-client.ts) and the server (lib/server/siws.ts).
// Anything that moves value, changes identity or grants access keeps
// requiring a per-request wallet signature — never add such an action here.
// A write is added only as one of the two kinds below, and only by name: on
// the session path the cookie alone authorizes the request (its params are
// not signed per request), and maintenance lets session actions through
// (lib/maintenance.ts refusedInMaintenance; it stops only the pre-send
// policy read).
//
// One kind of write is part of a read and allowed: an access-log row that
// records the read itself (lib/server/audit.ts writeServerAudit, e.g. the
// "kyc_document_view" row of clients.doc-url). Such a route must not change
// business data while maintenance is on (lib/maintenance.ts).
//
// Accepted exceptions, each a record of evidence that grants nothing and
// changes no business data, so that the caller is not asked to sign twice
// for one step: compliance.screenWallet, compliance.screenRecipients and
// compliance.distributionEvidence (screening records, see their entries), and
// admin.documentAnchorRecord, whose only write is the audit row of a document
// anchor the server first re-reads from the chain and verifies: finalized,
// signed by the session wallet alone, that wallet being Platform.admin
// (app/api/admin/document-anchor). Its params (signature, reference, hash)
// are unsigned, but the row is written only when the chain shows exactly that
// memo signed by the session wallet, so holding the Super Admin's session
// cookie only lets one record an anchor that wallet already signed. Any new
// exception must meet the same bar and be listed here.

export const SESSION_COOKIE = "manci_session";

/** How long one "sign in" lasts before the wallet is asked again. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export const SESSION_READ_ACTIONS: ReadonlySet<string> = new Set([
  "account.me",
  "account.wallets.transaction",
  // Menu counts only — integers per admin page (app/api/admin/badges).
  "admin.badges",
  // The Super Admin's document anchors (app/api/admin/document-anchor). The
  // list reads audit rows. Record WRITES (one of the accepted exceptions in
  // the header): its only write is the audit row of an anchor the server
  // re-reads from the chain and verifies (finalized, signed by the Super
  // Admin itself, Platform.admin checked): the transaction is the proof, the
  // row grants nothing and changes no business data, like the receipts
  // lib/maintenance.ts lets through. No second prompt after the send.
  "admin.documentAnchorList",
  "admin.documentAnchorRecord",
  "adminConfig.fxRatesRead",
  "adminConfig.raiseLimitsRead",
  "adminConfig.read",
  "applications.adminEvents",
  "applications.adminList",
  "applications.capacity",
  "applications.mine",
  "archive.check",
  "audit.list",
  "clients.adminDetail",
  "clients.adminList",
  "clients.doc-url",
  "clients.lookup",
  "clients.me",
  "compliance.list",
  // Which of N wallets have an unresolved alert — addresses only (issue gate).
  "compliance.openWallets",
  // The sanctions lists' freshness: dates, counts and codes (8.5).
  "compliance.sanctionsStatus",
  // The caller screens its OWN wallet before a buy (8.5); its only write is
  // the compliance alert of a hit, one per wallet while open.
  "compliance.screenWallet",
  // The sender of a distribution screens its recipients (Send to wallets):
  // addresses in, matching addresses out; its writes are the alert of a hit
  // and the record of the screen itself (lib/server/screening-evidence.ts).
  "compliance.screenRecipients",
  // Before the sender signs: checks those records for the run's recipients;
  // its only write is the evidence row that records the check.
  "compliance.distributionEvidence",
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
  "saleApprovals.capacity",
  "saleApprovals.list",
  "saleApprovals.mine",
  // Public-sale requests of a class (its issuer or an Admin) or waiting for the operator (Admin).
  "saleRequests.list",
  // Rolling EUR capacity and the issuance ledger of an SPV (Talas 5.1).
  "spvs.capacity",
  "spvs.issuances",
  "storage.documents.list",
  // Signs ONE confidential document on click; its only write is the access-log row.
  "storage.documents.url",
  "vesting-series.admin-list",
  "vesting-series.creation-state",
  "vesting-series.list-mine",
  "vesting.beneficiaries",
]);

export function isSessionReadAction(action: string): boolean {
  return SESSION_READ_ACTIONS.has(action);
}
