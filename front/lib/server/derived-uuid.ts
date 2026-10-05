// SERVER-ONLY — a row id the server derives instead of letting the database
// draw one, so a table's primary key keeps one row per thing: the retry
// worker's final "Send to wallets" row (lib/server/reconciled-audit
// reconciledAuditId) and a recorded document anchor
// (lib/server/document-anchor documentAnchorAuditId). Each caller namespaces
// its name with its own prefix, so two kinds of row never share an id.
// Rows already written keep the id they got: tests/derived-audit-ids.test.ts
// pins both derivations.

import "server-only";

import { createHash } from "node:crypto";

/**
 * A UUID version 8 (RFC 9562, variant 10xx), lowercase, from the first 16
 * bytes of SHA-256 of `name` (UTF-8). The same name always gives the same id.
 */
export function uuidV8FromSha256(name: string): string {
  const bytes = createHash("sha256").update(name, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
