import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  address,
  createNoopSigner,
  getAddressDecoder,
  getBase58Decoder,
} from "@solana/kit";
import {
  openCustodyOnce,
  parseCustodyVaultId,
  readCustodyOpenIntent,
  recordCustodyOpening,
  requireCustodyRequestAmount,
  type CustodyOpenIntent,
  type CustodyOpenScope,
} from "@/lib/custody-open-recovery";
import {
  getOpenCustodyVaultInstructionAsync,
  getOpenCustodyVaultInstructionDataDecoder,
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  RealizeAction,
  VaultType,
} from "@/lib/generated/asset_registry";
import { findCustodyVaultPda } from "@/lib/pdas";

const key = (n: number) =>
  getAddressDecoder().decode(new Uint8Array(32).fill(n));
const scope: CustodyOpenScope = {
  product: "conversion",
  requestId: "request-1",
  network: "devnet",
  wallet: key(1),
};
const signature = getBase58Decoder().decode(new Uint8Array(64).fill(1));
let entries: Map<string, string>;
let store: Storage;
beforeEach(() => {
  entries = new Map();
  store = {
    get length() {
      return entries.size;
    },
    key: (i) => [...entries.keys()][i] ?? null,
    getItem: (k) => entries.get(k) ?? null,
    setItem: (k, v) => {
      entries.set(k, v);
    },
    removeItem: (k) => {
      entries.delete(k);
    },
    clear: () => entries.clear(),
  };
  vi.stubGlobal("window", { localStorage: store });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function setup() {
  const assertUnoccupied = vi.fn(async (pda: string) => {
    void pda;
  });
  const build = vi.fn(async () => ({ instruction: "public" }));
  const send = vi.fn(async () => signature);
  const link = vi.fn(async (intent: CustodyOpenIntent) => {
    void intent;
  });
  const onIntent = vi.fn();
  return {
    scope,
    shareClass: key(2),
    vaultId: "42",
    assertUnoccupied,
    build,
    send,
    link,
    onIntent,
  };
}

describe("custody approval durable intent", () => {
  it.each(["delivery", "conversion"] as const)(
    "persists %s identity before broadcast and receipt before API; retry never builds or sends",
    async (product) => {
      const input = setup();
      input.scope = { ...scope, product };
      input.send.mockImplementation(async () => {
        const before = readCustodyOpenIntent(input.scope)!;
        expect(before.signature).toBeNull();
        expect(before.vaultPda).toBe(
          String(await findCustodyVaultPda(key(2), BigInt(42))),
        );
        return signature;
      });
      input.link.mockImplementationOnce(async (intent) => {
        expect(readCustodyOpenIntent(input.scope)?.signature).toBe(signature);
        expect(intent.signature).toBe(signature);
        throw new Error("database paused");
      });
      await expect(openCustodyOnce(input)).rejects.toThrow("database paused");
      const restored = readCustodyOpenIntent(input.scope)!;
      expect(restored.signature).toBe(signature);
      // A new consumer after reload sees the durable request and ignores changed form IDs.
      const retry = { ...setup(), scope: input.scope, vaultId: "999" };
      await openCustodyOnce(retry);
      expect(retry.build).not.toHaveBeenCalled();
      expect(retry.send).not.toHaveBeenCalled();
      expect(retry.link).toHaveBeenCalledWith(restored);
      expect(readCustodyOpenIntent(input.scope)?.recordedAt).toBeTruthy();
      expect(input.build).toHaveBeenCalledOnce();
      expect(input.send).toHaveBeenCalledOnce();
      // Retain completed public receipt: another stale requested tab still cannot send.
      await openCustodyOnce(retry);
      expect(retry.send).not.toHaveBeenCalled();
      expect(retry.build).not.toHaveBeenCalled();
      expect(Object.keys(JSON.parse([...entries.values()][0])).sort()).toEqual([
        "createdAt",
        "network",
        "product",
        "recordedAt",
        "requestId",
        "signature",
        "vaultId",
        "vaultPda",
        "version",
        "wallet",
      ]);
    },
  );
  it("retains the exact PDA for an uncertain send without a returned signature", async () => {
    const input = setup();
    input.send.mockRejectedValueOnce(new Error("RPC disconnected"));
    await expect(openCustodyOnce(input)).rejects.toThrow("RPC disconnected");
    expect(readCustodyOpenIntent(scope)?.signature).toBeNull();
    input.link.mockRejectedValueOnce(new Error("finalized vault unavailable"));
    await expect(openCustodyOnce(input)).rejects.toThrow(
      "finalized vault unavailable",
    );
    expect(input.build).toHaveBeenCalledOnce();
    expect(input.send).toHaveBeenCalledOnce();
  });
  it("blocked storage fails before build/send, and post-send storage failure retains visible signature", async () => {
    const input = setup();
    const fail = vi.spyOn(store, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    await expect(openCustodyOnce(input)).rejects.toThrow(
      "Enable browser storage",
    );
    expect(input.build).not.toHaveBeenCalled();
    expect(input.send).not.toHaveBeenCalled();
    fail.mockRestore();
    input.send.mockImplementation(async () => {
      vi.spyOn(store, "setItem").mockImplementation(() => {
        throw new Error("quota after send");
      });
      return signature;
    });
    await expect(openCustodyOnce(input)).rejects.toThrow("quota after send");
    expect(input.onIntent.mock.lastCall?.[0].signature).toBe(signature);
    expect(readCustodyOpenIntent(scope)?.signature).toBeNull();
    expect(input.link).not.toHaveBeenCalled();
  });
  it("isolates scope and fails closed on corrupt records or a foreign recording attempt", async () => {
    const input = setup();
    input.link.mockRejectedValue(new Error("offline"));
    await expect(openCustodyOnce(input)).rejects.toThrow("offline");
    const intent = readCustodyOpenIntent(scope)!;
    for (const foreign of [
      { ...scope, network: "mainnet" as const },
      { ...scope, wallet: key(3) },
      { ...scope, requestId: "request-2" },
      { ...scope, product: "delivery" as const },
    ]) {
      expect(readCustodyOpenIntent(foreign)).toBeNull();
      await expect(
        recordCustodyOpening(intent, foreign, vi.fn()),
      ).rejects.toThrow("wallet and network");
    }
    entries.set([...entries.keys()][0], "broken JSON");
    await expect(openCustodyOnce(input)).rejects.toThrow("needs review");
    expect(input.send).toHaveBeenCalledOnce();
  });
  it("rejects a tampered saved ID/PDA pairing without constructing another opening", async () => {
    const input = setup();
    input.link.mockRejectedValueOnce(new Error("database paused"));
    await expect(openCustodyOnce(input)).rejects.toThrow("database paused");
    const storageKey = [...entries.keys()][0];
    entries.set(
      storageKey,
      JSON.stringify({ ...readCustodyOpenIntent(scope), vaultId: "99" }),
    );
    await expect(openCustodyOnce(input)).rejects.toThrow("ID and address");
    expect(input.build).toHaveBeenCalledOnce();
    expect(input.send).toHaveBeenCalledOnce();
    expect(input.link).toHaveBeenCalledOnce();
  });
  it("an occupied vault ID is rejected before creating a recovery intent or transaction", async () => {
    const input = setup();
    input.assertUnoccupied.mockRejectedValueOnce(new Error("ID already used"));
    await expect(openCustodyOnce(input)).rejects.toThrow("ID already used");
    expect(readCustodyOpenIntent(scope)).toBeNull();
    expect(input.build).not.toHaveBeenCalled();
    expect(input.send).not.toHaveBeenCalled();
  });
  it("rejects mismatched amounts and unsafe IDs before an opening can be constructed", async () => {
    expect(requireCustodyRequestAmount("7", 7)).toBe(BigInt(7));
    for (const [amount, requested] of [
      ["8", 7],
      ["0", 0],
      ["1.5", 1.5],
      ["9007199254740992", 9007199254740992],
    ] as const)
      expect(() => requireCustodyRequestAmount(amount, requested)).toThrow(
        "exactly match",
      );
    expect(parseCustodyVaultId("9007199254740991")).toBe(
      BigInt(Number.MAX_SAFE_INTEGER),
    );
    for (const id of ["-1", "1.5", "", "9007199254740992"])
      expect(() => parseCustodyVaultId(id)).toThrow();
    const input = { ...setup(), vaultId: "9007199254740992" };
    await expect(openCustodyOnce(input)).rejects.toThrow("at most");
    expect(input.build).not.toHaveBeenCalled();
    expect(input.send).not.toHaveBeenCalled();
  });
  it("matches final Rust OpenCustodyVault ABI and derives the saved canonical PDA", async () => {
    const input = setup();
    const ix = await getOpenCustodyVaultInstructionAsync({
      authority: createNoopSigner(address(scope.wallet)),
      shareClass: key(2),
      mint: key(3),
      tokenProgram: address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
      vaultId: parseCustodyVaultId(input.vaultId),
      vaultType: VaultType.DeliveryEscrow,
      realizeAction: RealizeAction.BurnAndAttest,
      amount: requireCustodyRequestAmount("7", 7),
      deadline: BigInt(2000000000),
      metadataHash: new Uint8Array(32).fill(9),
      beneficiary: key(4),
    });
    expect(ix.programAddress).toBe(ASSET_REGISTRY_PROGRAM_ADDRESS);
    expect(ix.accounts).toHaveLength(9);
    expect(ix.accounts[4].address).toBe(
      await findCustodyVaultPda(key(2), BigInt(42)),
    );
    const decoded = getOpenCustodyVaultInstructionDataDecoder().decode(ix.data);
    expect(decoded.vaultId).toBe(BigInt(42));
    expect(decoded.amount).toBe(BigInt(7));
    expect(decoded.vaultType).toBe(VaultType.DeliveryEscrow);
    expect(decoded.realizeAction).toBe(RealizeAction.BurnAndAttest);
    expect(decoded.beneficiary).toBe(key(4));
  });
});
