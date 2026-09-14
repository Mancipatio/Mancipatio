import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBase58Decoder } from "@solana/kit";
import {
  assertChainRecordStorageAvailable,
  clearPendingChainRecord,
  listPendingChainRecords,
  readPendingChainRecord,
  savePendingChainRecord,
  type ChainRecordScope,
} from "@/lib/chain-record-recovery";

const WALLET = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const OTHER_WALLET = "5MZBGE68wKvzAiRnh9BLcxWzWZ9EGDgvS39mgLDLKTsy";
const SIGNATURE = "1".repeat(64);
const NEXT_SIGNATURE = getBase58Decoder().decode(new Uint8Array(64).fill(1));
const scope: ChainRecordScope = {
  kind: "delivery",
  network: "devnet",
  wallet: WALLET,
  entityId: "request-1",
};
let entries: Map<string, string>;
let store: Storage;

beforeEach(() => {
  entries = new Map();
  store = {
    get length() {
      return entries.size;
    },
    key: (index) => [...entries.keys()][index] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
    clear: () => entries.clear(),
  };
  vi.stubGlobal("window", { localStorage: store });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("durable chain receipt recovery", () => {
  it.each([
    "purchase",
    "delivery",
    "conversion",
    "delivery_return",
    "conversion_return",
    "custody_outcome",
  ] as const)(
    "restores %s receipts after a reload without request details",
    (kind) => {
      const saved = savePendingChainRecord({
        ...scope,
        kind,
        signature: SIGNATURE,
      });
      // A fresh module consumer reads the same persistent storage; no React state
      // or server availability is needed to recover the submitted signature.
      expect(readPendingChainRecord({ ...scope, kind })).toEqual(saved);
      expect(Object.keys(JSON.parse([...entries.values()][0])).sort()).toEqual([
        "createdAt",
        "entityId",
        "kind",
        "network",
        "signature",
        "version",
        "wallet",
      ]);
      expect(
        listPendingChainRecords({ kind, network: "devnet", wallet: WALLET }),
      ).toEqual([saved]);
    },
  );

  it("isolates wallets, networks, entities and operation types", () => {
    savePendingChainRecord({ ...scope, signature: SIGNATURE });
    for (const other of [
      { ...scope, wallet: OTHER_WALLET },
      { ...scope, network: "mainnet" as const },
      { ...scope, entityId: "request-2" },
      { ...scope, kind: "conversion" as const },
    ])
      expect(readPendingChainRecord(other)).toBeNull();
    expect(listPendingChainRecords({ ...scope, wallet: OTHER_WALLET })).toEqual(
      [],
    );
  });

  it("preserves the original receipt until recording explicitly succeeds", () => {
    const saved = savePendingChainRecord({ ...scope, signature: SIGNATURE });
    expect(readPendingChainRecord(scope)?.signature).toBe(SIGNATURE);
    clearPendingChainRecord(saved);
    expect(readPendingChainRecord(scope)).toBeNull();
  });

  it("does not let a delayed recording response delete a newer receipt", () => {
    const previous = savePendingChainRecord({ ...scope, signature: SIGNATURE });
    const next = savePendingChainRecord({
      ...scope,
      signature: NEXT_SIGNATURE,
    });
    clearPendingChainRecord(previous);
    expect(readPendingChainRecord(scope)).toEqual(next);
  });

  it("ignores corrupt or wrongly scoped stored entries", () => {
    savePendingChainRecord({ ...scope, signature: SIGNATURE });
    const key = [...entries.keys()][0];
    entries.set(key, "broken JSON");
    expect(readPendingChainRecord(scope)).toBeNull();
    entries.set(
      key,
      JSON.stringify({
        ...scope,
        wallet: OTHER_WALLET,
        signature: SIGNATURE,
        version: 1,
        createdAt: new Date().toISOString(),
      }),
    );
    expect(listPendingChainRecords(scope)).toEqual([]);
  });

  it("detects unavailable persistence before funds are sent", () => {
    const write = vi.spyOn(store, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(assertChainRecordStorageAvailable).toThrow("Enable browser storage");
    expect(write).toHaveBeenCalledOnce();
    expect(() =>
      savePendingChainRecord({ ...scope, signature: SIGNATURE }),
    ).toThrow("do not send the funds again");
  });

  it("checks storage writes and removes its availability probe", () => {
    assertChainRecordStorageAvailable();
    expect(entries.size).toBe(0);
  });
});
