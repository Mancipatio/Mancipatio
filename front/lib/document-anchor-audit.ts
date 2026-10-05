// The audit row of a recorded document anchor, without the rest of
// lib/document-anchor.ts (kit, the compute budget, the memo program): the
// admin audit feed (lib/audit-feed.ts) needs only these two strings.
//
// The row is written only by app/api/admin/document-anchor, after it verified
// the anchor's finalized transaction on chain; "operator" is a server-only
// category (lib/server/audit.ts SERVER_ONLY_AUDIT_CATEGORIES). Whether a row
// IS such a record is decided on the server (lib/server/document-anchor.ts
// isRecordedAnchorRow: the row id derived from the signature, which only the
// record route writes), and /api/audit/list hands that verdict to the page as
// anchor_verified.

export const DOCUMENT_ANCHOR_AUDIT = { category: "operator", ixName: "document_anchor" } as const;
