import { describe, expect, it, vi } from "vitest";
import { loadNetwork } from "@/lib/enumerate";
import { ASSET_REGISTRY_PROGRAM_ADDRESS, getShareClassDecoder, getShareClassEncoder } from "@/lib/generated/asset_registry";
import { indexerFixtures } from "./helpers/indexer-fixtures";
type Rpc = Parameters<typeof loadNetwork>[0];
function rpcFor(bytes: Uint8Array[], owner: string = ASSET_REGISTRY_PROGRAM_ADDRESS) {
  const getProgramAccounts = vi.fn(() => ({ send: async () => bytes.map((data) => ({ pubkey: "11111111111111111111111111111111", account: { owner, data: [Buffer.from(data).toString("base64"), "base64"] } })) }));
  return { rpc: { getProgramAccounts } as unknown as Rpc, call: getProgramAccounts };
}
describe("RPC fallback integrity", () => {
  it("returns complete generated current accounts from finalized data", async () => {
    const { rpc, call } = rpcFor(indexerFixtures().map((f) => f.bytes));
    const result = await loadNetwork(rpc); expect(result.assets).toHaveLength(1); expect(result.shareClasses).toHaveLength(1);
    expect(result.shareClasses[0].lifetimeMinted).toBe(BigInt(44)); expect(call.mock.calls[0]).toEqual([ASSET_REGISTRY_PROGRAM_ADDRESS, { encoding: "base64", commitment: "finalized" }]);
  });
  it("rejects a v1 ShareClass instead of inventing lifetime counters or hiding it", async () => {
    const f = indexerFixtures().find((f) => f.table === "share_classes")!;
    const old = new Uint8Array(getShareClassEncoder().encode({ ...getShareClassDecoder().decode(f.bytes), version: 1, lifetimeMinted: BigInt(0), cumulativeCap: false }));
    await expect(loadNetwork(rpcFor([old, f.bytes]).rpc)).rejects.toThrow(/ShareClass/);
    await expect(loadNetwork(rpcFor([old.slice(0, -9)]).rpc)).rejects.toThrow(/Unsupported ShareClass version 1/);
  });
  it("does not turn a malformed known account into missing balances", async () => {
    const fixtures = indexerFixtures(); fixtures[3].bytes = fixtures[3].bytes.slice(0, 15);
    await expect(loadNetwork(rpcFor(fixtures.map((f) => f.bytes)).rpc)).rejects.toThrow(/ShareClass/);
  });
  it("rejects the wrong owner and incomplete discriminator", async () => {
    await expect(loadNetwork(rpcFor([indexerFixtures()[0].bytes], "11111111111111111111111111111111").rpc)).rejects.toThrow(/owner/);
    await expect(loadNetwork(rpcFor([new Uint8Array(3)]).rpc)).rejects.toThrow(/discriminator/);
  });
});
