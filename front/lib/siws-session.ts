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
// for one step: compliance.screenWallet, compliance.screenRecipients,
// compliance.distributionEvidence and tokenMigration.precheck (screening
// records or the alert of a hit, see their entries), and
// admin.documentAnchorRecord, whose only write is the audit row of a document
// anchor the server first re-reads from the chain and verifies: finalized,
// signed by the session wallet alone, that wallet being Platform.admin
// (app/api/admin/document-anchor). Its params (signature, reference, hash)
// are unsigned, but the row is written only when the chain shows exactly that
// memo signed by the session wallet, so holding the Super Admin's session
// cookie only lets one record an anchor that wallet already signed.
// issuerUpdates.anchor is the same record for an issuer update: its only
// write is the update's anchor_tx, set once, after the server re-read the
// finalized transaction and found exactly the memo it computes itself for
// that published update, signed by the session wallet alone, that wallet
// being the issuer's on-chain authority (app/api/issuer-updates/anchor). Two
// more meet the same bar, the certificate steps after a wallet already acted
// (app/api/admin/certificates): certificates.sign, whose only write is a
// certificate's signature after the server verified that the session wallet
// itself signed exactly that certificate (its number and the hash of its
// stored payload, the draft naming that wallet as signer), and
// certificates.anchor, whose only write is the anchor transaction of a
// signed certificate, taken only from an anchor the record route above
// already verified on chain for that number and hash. Both are the Super
// Admin's alone (requireSuperAdmin) and refused during maintenance all the
// same (lib/maintenance.ts). Any new exception
// must meet the same bar and be listed here.

export const SESSION_COOKIE = "manci_session";

/** How long one "sign in" lasts before the wallet is asked again. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export const SESSION_READ_ACTIONS: ReadonlySet<string> = new Set([
  "account.me",
  "account.wallets.transaction",
  // Menu counts only — integers per admin page (app/api/admin/badges).
  "admin.badges",
  // Registered accounts before KYC/KYB; the route rechecks the admin role.
  "admin.accountsList",
  // Names (0092) and linked accounts of the wallets on /admin/admins; the
  // route rechecks the admin role. Naming a wallet signs afresh
  // (admin.walletLabelSet, Super Admin only).
  "admin.walletLabels",
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
  // The signer's own apply verdict (KYC/KYB) — never another wallet's.
  "applications.eligibility",
  "applications.mine",
  "archive.check",
  // Admin-only knowledge list; publishing and deletion require fresh signatures.
  "assistantKnowledge.list",
  "audit.list",
  // The cap table of one asset, read only: the admin's reconciliation, and an
  // issuer's own asset (wallets, units and decision references). Recording,
  // voiding and the CSV export require fresh signatures.
  "capTable.adminRead",
  "capTable.issuerRead",
  // Certificates (app/api/admin/certificates): list, detail and preview are
  // admin reads (the preview reads the chain and writes nothing). sign and
  // anchor are the accepted exceptions in the header: each records only
  // evidence the server verifies first. create and revoke need a signature.
  "certificates.anchor",
  "certificates.list",
  "certificates.preview",
  "certificates.read",
  "certificates.sign",
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
  // The fee schedule (drafts included) and charges; every fee write signs afresh.
  "fees.scheduleList",
  "inquiries.list",
  "issuer-profiles.read",
  // Investor relations (0090): the issuer's own list, the admins' moderation
  // list, a holder's read (balances checked on chain) and ONE document link
  // signed on click; none of them writes anything.
  "issuerUpdates.adminList",
  "issuerUpdates.documentUrl",
  "issuerUpdates.holderRead",
  "issuerUpdates.mine",
  // Records the anchor of a published update (an accepted exception, see the header).
  "issuerUpdates.anchor",
  "otc.adminScreen",
  "otc.list",
  "passport.list",
  "payout-snapshots.adminRead",
  "payout-snapshots.proof",
  // The signer's own purchases, OTC deals and conversions plus daily EUR
  // rates, for the portfolio CSV export (app/api/portfolio/export).
  "portfolio.export",
  "profiles.read",
  // The seller's own listings or the admin board (0082: a listing is public only while active).
  "resell.list",
  "saleApprovals.capacity",
  "saleApprovals.list",
  "saleApprovals.mine",
  // Public-sale requests of a class (its issuer or an Admin) or waiting for the operator (Admin).
  "saleRequests.list",
  // Rolling EUR capacity and the issuance ledger of an SPV (Talas 5.1).
  "spvs.capacity",
  "spvs.issuances",
  "storage.documents.list",
  // Token migration (app/api/token-migrations): the admin's chain read of an
  // old mint and its excluded wallets, and the campaigns with their deposits
  // (every write needs a fresh signature).
  "tokenMigration.adminInspect",
  "tokenMigration.adminList",
  // The holder's own pre-deposit check (module, window, cap, excluded wallet,
  // its balance, the Terms), like compliance.screenWallet: its only write is
  // the compliance alert of a sanctions hit on the caller's own wallet. The
  // deposit itself is the holder's wallet transaction, and its record
  // (tokenMigration.recordDeposit) needs a fresh signature.
  "tokenMigration.precheck",
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
