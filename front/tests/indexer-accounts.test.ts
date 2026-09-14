import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { decodeIndexerAccount, INDEXER_ENTITIES, INDEXER_PROGRAM } from "@/lib/server/indexer-accounts";
import { indexerFixtures } from "./helpers/indexer-fixtures";
import { getShareClassDecoder, getShareClassEncoder } from "@/lib/generated/asset_registry";

describe("one generated indexer decoder", () => {
  it("covers all 14 existing mirror entities with complete typed non-zero projections", async () => {
    const fixtures = indexerFixtures(); expect(fixtures.map((f) => f.table)).toEqual(INDEXER_ENTITIES.map((e) => e.table));
    for (const f of fixtures) {
      const entity = INDEXER_ENTITIES.find((e) => e.table === f.table)!;
      const row = await entity.decode(f.bytes);
      const result = await decodeIndexerAccount(String(row.pda), INDEXER_PROGRAM, f.bytes);
      expect(result).toEqual({ table: f.table, row });
      if (f.table === "share_classes") expect(row).toMatchObject({ lifetime_minted: "44", cumulative_cap: true, liq_pref_multi_bps: 15000, account_version: 2 });
      if (f.table === "offers") expect(row.deposited).toBe("8");
      if (f.table === "kyc_registries") expect(String(row.approved_jurisdictions)).toHaveLength(256);
    }
  });
  it("rejects the wrong PDA, incomplete known type and explicit legacy version", async () => {
    const f = indexerFixtures().find((f) => f.table === "share_classes")!;
    await expect(decodeIndexerAccount("11111111111111111111111111111111", INDEXER_PROGRAM, f.bytes)).rejects.toThrow(/PDA/);
    await expect(decodeIndexerAccount("11111111111111111111111111111111", INDEXER_PROGRAM, f.bytes.slice(0, 15))).rejects.toThrow();
    const old = new Uint8Array(getShareClassEncoder().encode({ ...getShareClassDecoder().decode(f.bytes), version: 1, lifetimeMinted: BigInt(0), cumulativeCap: false }));
    const legacyRow = await INDEXER_ENTITIES.find((e) => e.table === "share_classes")!.decode(old);
    expect(await decodeIndexerAccount(String(legacyRow.pda), INDEXER_PROGRAM, old)).toMatchObject({ row: { account_version: 1, lifetime_minted: null, cumulative_cap: null, readonly_legacy: true } });
  });
  it("does not project foreign-owned or untracked account types", async () => {
    const f = indexerFixtures()[0];
    expect(await decodeIndexerAccount("11111111111111111111111111111111", "11111111111111111111111111111111", f.bytes)).toBeNull();
    expect(await decodeIndexerAccount("11111111111111111111111111111111", INDEXER_PROGRAM, new Uint8Array(8))).toBeNull();
  });
});
