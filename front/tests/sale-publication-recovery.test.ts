import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  isPermanentPublicationError,
  listSalePublications,
  saveSalePublication,
  clearSalePublication,
  assertSaleIntentUnsent,
  type PendingSalePublication,
} from "@/lib/sale-publication-recovery";
const wallet = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2",
  sale = "5MZBGE68wKvzAiRnh9BLcxWzWZ9EGDgvS39mgLDLKTsy";
const intent: PendingSalePublication = {
  version: 1,
  network: "devnet",
  wallet,
  salePda: sale,
  signature: null,
  lastValidBlockHeight: "100",
  listing: {
    sale_pubkey: sale,
    application_id: "application",
    logo_letter: "M",
    is_published: true,
  },
};
let entries: Map<string, string>;
beforeEach(() => {
  entries = new Map();
  vi.stubGlobal("window", {
    dispatchEvent: vi.fn(),
    localStorage: {
      get length() {
        return entries.size;
      },
      key: (i: number) => [...entries.keys()][i],
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
      removeItem: (key: string) => entries.delete(key),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());
it("retains pre-signing sale address and publication payload across reloads, isolated by network and wallet", () => {
  saveSalePublication(intent);
  expect(listSalePublications("devnet", wallet)).toEqual([intent]);
  expect(listSalePublications("mainnet", wallet)).toEqual([]);
  expect(listSalePublications("devnet", sale)).toEqual([]);
  saveSalePublication({ ...intent, signature: "1".repeat(64) });
  expect(listSalePublications("devnet", wallet)[0].signature).toBe(
    "1".repeat(64),
  );
  clearSalePublication(intent);
  expect(entries.size).toBe(0);
});
it("fails closed on unreadable intent instead of opening another sale", () => {
  saveSalePublication(intent);
  entries.set([...entries.keys()][0], "{}");
  expect(() => listSalePublications("devnet", wallet)).toThrow("unreadable");
});
it("requires absence in a finalized bank past expiry, avoiding a separate later-height race", async () => {
  const getBlock = vi.fn(
      (slot: bigint) => (
        void slot,
        {
          send: async () => ({ blockHeight: BigInt(101) }),
        }
      ),
    ),
    getAccountInfo = vi.fn(() => ({
      send: async () => ({ context: { slot: BigInt(200) }, value: null }),
    }));
  const rpc = { getBlock, getAccountInfo } as unknown as Parameters<
    typeof assertSaleIntentUnsent
  >[0];
  await assertSaleIntentUnsent(rpc, intent);
  expect(getBlock.mock.calls[0]?.[0]).toBe(BigInt(200));
  getBlock.mockReturnValue({
    send: async () => ({ blockHeight: BigInt(100) }),
  });
  await expect(assertSaleIntentUnsent(rpc, intent)).rejects.toThrow(
    "still land",
  );
  getAccountInfo.mockReturnValue({
    send: async () => ({ context: { slot: BigInt(202) }, value: {} }),
  } as never);
  getBlock.mockClear();
  await expect(assertSaleIntentUnsent(rpc, intent)).rejects.toThrow(
    "exists on-chain",
  );
  expect(getBlock).not.toHaveBeenCalled();
});

it("tells a refusal no retry can fix from a transient failure", () => {
  for (const message of [
    "application does not belong to this issuer",
    "application is already linked to another sale",
    "a linked application cannot be replaced",
    "application must be approved on this network",
  ]) expect(isPermanentPublicationError(message)).toBe(true);
  for (const message of [
    "Sale listing publication unavailable. Retry publishing the existing sale",
    "Network request failed",
    undefined,
  ]) expect(isPermanentPublicationError(message)).toBe(false);
});
