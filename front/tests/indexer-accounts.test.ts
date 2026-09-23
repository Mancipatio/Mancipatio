import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { decodeIndexerAccount, INDEXER_ENTITIES, INDEXER_PROGRAM } from "@/lib/server/indexer-accounts";
import { indexerFixtures } from "./helpers/indexer-fixtures";
import {
  getAuthorityTransferEncoder,
  getCustodyVaultDecoder,
  getCustodyVaultEncoder,
  getIssuerDecoder,
  getIssuerEncoder,
  getIssuerRecoveryEncoder,
  getSaleDecoder,
  getSaleEncoder,
  getShareClassDecoder,
  getShareClassEncoder,
} from "@/lib/generated/asset_registry";
import { address } from "@solana/kit";

describe("one generated indexer decoder", () => {
  it("covers all 14 existing mirror entities with complete typed non-zero projections", async () => {
    const fixtures = indexerFixtures(); expect(fixtures.map((f) => f.table)).toEqual(INDEXER_ENTITIES.map((e) => e.table));
    for (const f of fixtures) {
      const entity = INDEXER_ENTITIES.find((e) => e.table === f.table)!;
      const row = await entity.decode(f.bytes, f.address);
      const result = await decodeIndexerAccount(String(row.pda), INDEXER_PROGRAM, f.bytes);
      expect(result).toEqual({ table: f.table, row });
      if (f.table === "share_classes") expect(row).toMatchObject({ lifetime_minted: "44", cumulative_cap: true, liq_pref_multi_bps: 15000, account_version: 2 });
      if (f.table === "offers") expect(row.deposited).toBe("8");
      if (f.table === "kyc_registries") expect(String(row.approved_jurisdictions)).toHaveLength(256);
    }
  });
  it("rejects the wrong PDA, incomplete known type and a v1 share class", async () => {
    const f = indexerFixtures().find((f) => f.table === "share_classes")!;
    await expect(decodeIndexerAccount("11111111111111111111111111111111", INDEXER_PROGRAM, f.bytes)).rejects.toThrow(/PDA/);
    await expect(decodeIndexerAccount("11111111111111111111111111111111", INDEXER_PROGRAM, f.bytes.slice(0, 15))).rejects.toThrow();
    const entity = INDEXER_ENTITIES.find((e) => e.table === "share_classes")!;
    const row = await entity.decode(f.bytes, null);
    // The snapshot function (0047) still requires the column; v2 always emits false.
    expect(row).toMatchObject({ account_version: 2, readonly_legacy: false });
    const old = new Uint8Array(getShareClassEncoder().encode({ ...getShareClassDecoder().decode(f.bytes), version: 1, lifetimeMinted: BigInt(0), cumulativeCap: false }));
    await expect(entity.decode(old, null)).rejects.toThrow(/share_classes account version 1 requires an explicit migration/);
    await expect(decodeIndexerAccount(String(row.pda), INDEXER_PROGRAM, old)).rejects.toThrow(/share_classes account version 1 requires an explicit migration/);
  });
  it("projects Sale v2 (the consumed approval and its application hash) and rejects a v1 Sale", async () => {
    const f = indexerFixtures().find((f) => f.table === "sales")!;
    const row = await INDEXER_ENTITIES.find((e) => e.table === "sales")!.decode(f.bytes, null);
    expect(row).toMatchObject({ account_version: 2, sale_approval: "SysvarC1ock11111111111111111111111111111111", application_hash: "07".repeat(32) });
    const v1 = new Uint8Array(getSaleEncoder().encode({ ...getSaleDecoder().decode(f.bytes), version: 1 }));
    await expect(decodeIndexerAccount(String(row.pda), INDEXER_PROGRAM, v1)).rejects.toThrow(/version 1 requires an explicit migration/);
    // A v1-sized (222-byte) account cannot decode as a Sale at all.
    await expect(decodeIndexerAccount(String(row.pda), INDEXER_PROGRAM, f.bytes.slice(0, 222))).rejects.toThrow();
  });
  it("projects CustodyVault v2 (kyc_registry), rejects v1 and a 237-byte account", async () => {
    const f = indexerFixtures().find((f) => f.table === "custody_vaults")!;
    expect(f.bytes.length).toBe(269);
    const entity = INDEXER_ENTITIES.find((e) => e.table === "custody_vaults")!;
    const row = await entity.decode(f.bytes, null);
    expect(row).toMatchObject({ account_version: 2, kyc_registry: "SysvarC1ock11111111111111111111111111111111", deposited: "33" });
    // An unpinned (non-delivery) vault projects null, not the default key.
    const unpinned = new Uint8Array(getCustodyVaultEncoder().encode({ ...getCustodyVaultDecoder().decode(f.bytes), kycRegistry: address("11111111111111111111111111111111") }));
    expect(await entity.decode(unpinned, null)).toMatchObject({ kyc_registry: null });
    const v1 = new Uint8Array(getCustodyVaultEncoder().encode({ ...getCustodyVaultDecoder().decode(f.bytes), version: 1 }));
    await expect(decodeIndexerAccount(String(row.pda), INDEXER_PROGRAM, v1)).rejects.toThrow(/version 1 requires an explicit migration/);
    // A v1-sized (237-byte) account cannot decode as a CustodyVault at all.
    await expect(decodeIndexerAccount(String(row.pda), INDEXER_PROGRAM, f.bytes.slice(0, 237))).rejects.toThrow();
  });
  it("does not project foreign-owned or untracked account types", async () => {
    const f = indexerFixtures()[0];
    expect(await decodeIndexerAccount("11111111111111111111111111111111", "11111111111111111111111111111111", f.bytes)).toBeNull();
    expect(await decodeIndexerAccount("11111111111111111111111111111111", INDEXER_PROGRAM, new Uint8Array(8))).toBeNull();
  });
});

describe("issuer authority rotation (2C-2)", () => {
  const key = address("11111111111111111111111111111111");
  const other = address("SysvarC1ock11111111111111111111111111111111");
  it("ignores the staged transfer and recovery accounts (no mirror table)", async () => {
    const recovery = new Uint8Array(getIssuerRecoveryEncoder().encode({
      issuer: key, currentAuthority: key, newAuthority: other, proposedBy: key,
      proposedAt: BigInt(1), eta: BigInt(2), expiresAt: BigInt(3), version: 1, bump: 255,
    }));
    const transfer = new Uint8Array(getAuthorityTransferEncoder().encode({
      target: key, currentAuthority: key, newAuthority: other, proposedBy: key, bump: 255,
    }));
    expect(await decodeIndexerAccount(String(key), INDEXER_PROGRAM, recovery)).toBeNull();
    expect(await decodeIndexerAccount(String(key), INDEXER_PROGRAM, transfer)).toBeNull();
  });
  it("re-projects a rotated Issuer with the new authority and nothing else changed", async () => {
    const f = indexerFixtures().find((f) => f.table === "issuers")!;
    const entity = INDEXER_ENTITIES.find((e) => e.table === "issuers")!;
    const before = await entity.decode(f.bytes, null);
    const rotated = new Uint8Array(getIssuerEncoder().encode({ ...getIssuerDecoder().decode(f.bytes), authority: other }));
    expect(rotated.length).toBe(117);
    const result = await decodeIndexerAccount(String(before.pda), INDEXER_PROGRAM, rotated);
    expect(result).toEqual({ table: "issuers", row: { ...before, authority: other } });
  });
});
