// lib/issuer-freeze: the pure parts of the D1 freeze UI (who may press which
// button, the reason-hash rule, the one-line record).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Address } from "@solana/kit";
import {
  describeIssuerFreeze,
  freezeActionGate,
  freezeReasonHash,
  hashHex,
  isEmptyReasonHash,
  reasonMatchesHash,
} from "@/lib/issuer-freeze";

const SA = { isAdmin: true, isSuperAdmin: true };
const ADMIN = { isAdmin: true, isSuperAdmin: false };
const NOBODY = { isAdmin: false, isSuperAdmin: false };

describe("freezeActionGate", () => {
  it("waits for the freeze state", () => {
    const g = freezeActionGate(SA, null);
    expect(g.freeze).toMatch(/Reading/);
    expect(g.unfreeze).toMatch(/Reading/);
  });

  it("any Admin (or the Super Admin) freezes a live issuer; nobody else", () => {
    expect(freezeActionGate(ADMIN, false).freeze).toBeNull();
    expect(freezeActionGate(SA, false).freeze).toBeNull();
    expect(freezeActionGate(NOBODY, false).freeze).toMatch(/Admin/);
    expect(freezeActionGate(SA, false).unfreeze).toMatch(/not frozen/);
  });

  it("only the Super Admin unfreezes; a second freeze is never offered", () => {
    expect(freezeActionGate(SA, true).unfreeze).toBeNull();
    expect(freezeActionGate(ADMIN, true).unfreeze).toMatch(/Only the Super Admin/);
    expect(freezeActionGate(NOBODY, true).unfreeze).toMatch(/Only the Super Admin/);
    expect(freezeActionGate(SA, true).freeze).toMatch(/already frozen/);
  });
});

describe("reason hash", () => {
  it("is SHA-256 of the trimmed UTF-8 text", async () => {
    const hash = await freezeReasonHash("  Case 42: unpaid čeks  ");
    expect(hashHex(hash)).toBe(createHash("sha256").update("Case 42: unpaid čeks", "utf8").digest("hex"));
    expect(hash).toHaveLength(32);
  });

  it("matches only the same text, never an empty one", async () => {
    const hash = await freezeReasonHash("Case 42");
    expect(await reasonMatchesHash(" Case 42 ", hash)).toBe(true);
    expect(await reasonMatchesHash("Case 43", hash)).toBe(false);
    expect(await reasonMatchesHash("   ", new Uint8Array(32))).toBe(false);
  });

  it("recognises a freeze without a reason", () => {
    expect(isEmptyReasonHash(new Uint8Array(32))).toBe(true);
    expect(isEmptyReasonHash(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 1 : 0)))).toBe(false);
  });
});

it("describeIssuerFreeze names the time (UTC) and the freezer", () => {
  const frozenBy = "11111111111111111111111111111111" as Address;
  const line = describeIssuerFreeze({
    address: frozenBy,
    issuer: frozenBy,
    frozenBy,
    frozenAt: BigInt(1_700_000_000),
    reasonHash: new Uint8Array(32),
  });
  expect(line).toBe(`Frozen on 2023-11-14 22:13 UTC by ${frozenBy}.`);
});
