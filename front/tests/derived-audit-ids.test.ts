// The audit row ids the server derives instead of letting the database draw
// one: the retry worker's final "Send to wallets" row
// (lib/server/reconciled-audit reconciledAuditId) and a recorded document
// anchor (lib/server/document-anchor documentAnchorAuditId). Each is a UUID
// version 8 (RFC 9562) from SHA-256 of a namespaced name, and the server
// finds its own rows by it: the worker counts a transaction as settled only
// when its row with that id exists, and the primary key keeps one anchor row
// per signature. A row already written keeps the id it got, so the ids are
// pinned here to literal values: a change to either derivation would make
// the server miss its existing rows and write a second one.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { reconciledAuditId } from "@/lib/server/reconciled-audit";
import { documentAnchorAuditId } from "@/lib/server/document-anchor";

// The Super Admin's mainnet transaction the anchor tests use (5RBDZ…).
const SIG = "5RBDZNDobPiJGpQsfcvPLuSdzyUXRxBnpXNU4sFQg2ud3sTiSPyWnPrfvyN4myMYTvEUWjtYnGijuryNNrXqeDqm";
const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** RFC 9562 version 8 from SHA-256, spelled out independently of the code under test. */
function referenceUuid(name: string): string {
  const b = Buffer.from(createHash("sha256").update(Buffer.from(name, "utf8")).digest()).subarray(0, 16);
  b[6] = 0x80 | (b[6] & 0x0f);
  b[8] = 0x80 | (b[8] & 0x3f);
  const h = b.toString("hex");
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join("-");
}

describe("derived audit row ids", () => {
  it("reconciledAuditId: the pinned id of a transaction on each network", () => {
    expect(reconciledAuditId("mainnet", SIG)).toBe("1b3f080d-88a9-868f-b197-6bb8d9f846b8");
    expect(reconciledAuditId("devnet", SIG)).toBe("d08b8f18-2a47-8a92-9ab9-a8c7d3940302");
    expect(reconciledAuditId("mainnet", SIG)).toBe(referenceUuid(`manci:distribution-audit:v1:mainnet:${SIG}`));
  });

  it("documentAnchorAuditId: the pinned id of an anchor on each network", () => {
    expect(documentAnchorAuditId("mainnet", SIG)).toBe("b2cc0020-8ce8-87cb-b9f4-99ff3aecd8fd");
    expect(documentAnchorAuditId("devnet", SIG)).toBe("b4c2fc75-b517-8a49-8f74-9f7a0e73e5b4");
    expect(documentAnchorAuditId("mainnet", SIG)).toBe(referenceUuid(`mancipatio:document_anchor:mainnet:${SIG}`));
  });

  it("both are lowercase version 8 UUIDs, and the two kinds of row never share an id", () => {
    for (const network of ["mainnet", "devnet"]) {
      expect(reconciledAuditId(network, SIG)).toMatch(UUID_V8);
      expect(documentAnchorAuditId(network, SIG)).toMatch(UUID_V8);
      expect(reconciledAuditId(network, SIG)).not.toBe(documentAnchorAuditId(network, SIG));
    }
  });
});
