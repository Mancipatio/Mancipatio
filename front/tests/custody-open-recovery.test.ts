import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  address,
  createNoopSigner,
  getAddressDecoder,
  getBase58Decoder,
} from "@solana/kit";
import {
  awaitCustodyOpenFinalized,
  checkCustodyOpenIntent,
  custodySendNeverBroadcast,
  CUSTODY_OPEN_ABANDON_AFTER_MS,
  forgetCustodyOpenIntent,
  isWalletRejection,
  NEVER_BROADCAST_ERROR_NAMES,
  openCustodyOnce,
  parseCustodyVaultId,
  readCustodyOpenIntent,
  recordCustodyOpening,
  requireCustodyRequestAmount,
  WALLET_POLICY_REFUSAL_PREFIX,
  type CustodyOpenCheckRpc,
  type CustodyOpenIntent,
  type CustodyOpenScope,
} from "@/lib/custody-open-recovery";
import {
  KycOnlyFlowError,
  ModuleDisabledFlowError,
  PausedFlowError,
} from "@/lib/pause-gate";
import { PAUSE_CUSTODY_ENTRY } from "@/lib/pause-flags";
import {
  SimulationRefusedError,
  SimulationUnavailableError,
} from "@/lib/simulation-gate";
import { MaintenanceModeError, MaintenanceUnknownError } from "@/lib/maintenance";
import {
  PrimaryWalletRequiredError,
  TransactionWalletChangedError,
} from "@/lib/transaction-wallet-policy";
import { AssetRegistryInstruction } from "@/lib/generated/asset_registry";
import {
  findPlatformPda,
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
      kycRegistry: key(5),
    });
    expect(ix.programAddress).toBe(ASSET_REGISTRY_PROGRAM_ADDRESS);
    expect(ix.accounts).toHaveLength(11);
    // Emergency-pause gate: the Platform PDA keeps index 9.
    expect(ix.accounts[9].address).toBe((await findPlatformPda())[0]);
    // 2C-3: a DeliveryEscrow pins the KYC registry, appended last.
    expect(ix.accounts[10].address).toBe(key(5));
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
  it("fills the optional KYC registry slot with the program id for a quarantine vault", async () => {
    const ix = await getOpenCustodyVaultInstructionAsync({
      authority: createNoopSigner(address(scope.wallet)),
      shareClass: key(2),
      mint: key(3),
      tokenProgram: address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
      vaultId: BigInt(1),
      vaultType: VaultType.RedemptionQueue,
      realizeAction: RealizeAction.BurnAndAttest,
      amount: BigInt(0),
      deadline: BigInt(0),
      metadataHash: new Uint8Array(32).fill(9),
      beneficiary: address("11111111111111111111111111111111"),
    });
    expect(ix.accounts).toHaveLength(11);
    expect(ix.accounts[9].address).toBe((await findPlatformPda())[0]);
    expect(ix.accounts[10].address).toBe(ASSET_REGISTRY_PROGRAM_ADDRESS);
  });
});

// F006: an intent is saved only once the pre-wallet gates passed, and a send
// that provably never reached the network takes its intent with it. The
// retention test above ("retains the exact PDA for an uncertain send") still
// holds: without `notSent`, or for an error that may have been broadcast, the
// intent stays — retention is now for uncertain sends only.
describe("custody approval intent: never-broadcast sends and the preflight", () => {
  const paused = () =>
    new PausedFlowError(
      PAUSE_CUSTODY_ENTRY,
      AssetRegistryInstruction.OpenCustodyVault,
    );
  it("forgets the intent of a send refused before the wallet, so the next approval builds and sends again", async () => {
    const input = { ...setup(), notSent: custodySendNeverBroadcast };
    input.send.mockRejectedValueOnce(paused());
    await expect(openCustodyOnce(input)).rejects.toThrow(
      "Nothing was sent to your wallet",
    );
    expect(readCustodyOpenIntent(scope)).toBeNull();
    expect(input.onIntent.mock.lastCall?.[0]).toBeNull();
    // The same inputs again: a fresh build, a fresh send, then the link.
    await openCustodyOnce(input);
    expect(input.build).toHaveBeenCalledTimes(2);
    expect(input.send).toHaveBeenCalledTimes(2);
    expect(input.link).toHaveBeenCalledOnce();
    expect(readCustodyOpenIntent(scope)?.signature).toBe(signature);
  });
  it("a preflight refusal saves no intent and never calls send", async () => {
    const input = {
      ...setup(),
      preflight: vi.fn(async () => {
        throw paused();
      }),
    };
    await expect(openCustodyOnce(input)).rejects.toThrow("paused");
    expect(readCustodyOpenIntent(scope)).toBeNull();
    expect(input.build).toHaveBeenCalledOnce();
    expect(input.preflight).toHaveBeenCalledWith({ instruction: "public" });
    expect(input.send).not.toHaveBeenCalled();
    expect(input.onIntent).not.toHaveBeenCalled();
  });
  it("a never-broadcast send leaves alone a record another attempt wrote meanwhile", async () => {
    for (const change of ["createdAt", "signature"] as const) {
      entries.clear();
      const input = { ...setup(), notSent: () => true };
      input.send.mockImplementationOnce(async () => {
        const storageKey = [...entries.keys()][0];
        const current = readCustodyOpenIntent(scope)!;
        entries.set(
          storageKey,
          JSON.stringify(
            change === "createdAt"
              ? { ...current, createdAt: new Date(1).toISOString() }
              : { ...current, signature },
          ),
        );
        throw paused();
      });
      await expect(openCustodyOnce(input)).rejects.toThrow("paused");
      const kept = readCustodyOpenIntent(scope)!;
      expect(kept).not.toBeNull();
      if (change === "signature") expect(kept.signature).toBe(signature);
      else expect(kept.createdAt).toBe(new Date(1).toISOString());
      expect(input.onIntent.mock.lastCall?.[0]).not.toBeNull();
    }
  });
  it("without notSent, or for an error that may have been broadcast, the intent stays", async () => {
    const input = { ...setup(), notSent: custodySendNeverBroadcast };
    input.send.mockRejectedValueOnce(new Error("RPC disconnected"));
    await expect(openCustodyOnce(input)).rejects.toThrow("RPC disconnected");
    expect(readCustodyOpenIntent(scope)?.signature).toBeNull();
    expect(input.onIntent.mock.lastCall?.[0]).not.toBeNull();
  });
  it("classifies the typed pre-wallet refusals and the wallet's rejection as never broadcast, nothing else", () => {
    const refused = [
      paused(),
      new ModuleDisabledFlowError(
        "custodyConversion",
        AssetRegistryInstruction.OpenCustodyVault,
        "devnet",
      ),
      new KycOnlyFlowError(AssetRegistryInstruction.DepositToCustodyVault),
      new SimulationRefusedError({
        detail: "Step 1 of 1 was refused.",
        instructionIndex: 0,
        instructionCount: 1,
        program: null,
        code: null,
        errorName: null,
        logs: [],
        err: null,
      }),
      new SimulationUnavailableError("devnet", new Error("429")),
      new MaintenanceModeError("Upgrade"),
      new MaintenanceUnknownError(),
      new PrimaryWalletRequiredError(),
      Object.assign(new Error("Proceeds are frozen"), {
        name: "GateAccountSetError",
      }),
      new Error(
        `${WALLET_POLICY_REFUSAL_PREFIX}. Approve the wallet verification and try again.`,
      ),
      Object.assign(new Error("User rejected the request."), { code: 4001 }),
      { code: "WALLET_REJECTED", message: "no" },
      new Error("Transaction cancelled by user"),
      // Wrapped by the SDK: found down the cause chain.
      new Error("Failed to send", { cause: new Error("x", { cause: paused() }) }),
    ];
    for (const error of refused)
      expect(custodySendNeverBroadcast(error), String(error)).toBe(true);
    for (const error of refused.slice(0, 9))
      expect(NEVER_BROADCAST_ERROR_NAMES.has((error as Error).name)).toBe(true);
    const uncertain = [
      new Error("RPC disconnected"),
      new Error("Transaction simulation failed: Blockhash not found"),
      new TransactionWalletChangedError(),
      new TypeError("Failed to fetch"),
      null,
      undefined,
      "sent",
      { code: 4002 },
    ];
    for (const error of uncertain)
      expect(custodySendNeverBroadcast(error), String(error)).toBe(false);
    expect(isWalletRejection(new Error("Insufficient funds"))).toBe(false);
    // The wallet-policy wording is matched by its opening words: pin them at the source.
    expect(
      readFileSync(join(process.cwd(), "lib/transaction-wallet-policy.ts"), "utf8"),
    ).toContain(`"${WALLET_POLICY_REFUSAL_PREFIX}.`);
  });
});

type FakeStatus =
  | { err: unknown; confirmationStatus?: string | null }
  | null;
function fakeRpc(opts: {
  account?: boolean | (() => boolean);
  status?: FakeStatus | (() => FakeStatus);
  fail?: boolean;
}) {
  const calls: string[] = [];
  const rpc = {
    getAccountInfo: (addr: string) => ({
      send: async () => {
        calls.push(`account:${addr}`);
        if (opts.fail) throw new Error("rpc down");
        const present =
          typeof opts.account === "function" ? opts.account() : !!opts.account;
        return {
          context: { slot: BigInt(1) },
          value: present
            ? {
                data: ["", "base64"],
                executable: false,
                lamports: BigInt(1),
                owner: key(9),
                rentEpoch: BigInt(0),
                space: BigInt(0),
              }
            : null,
        };
      },
    }),
    getSignatureStatuses: (sigs: string[], config: unknown) => ({
      send: async () => {
        calls.push(`status:${sigs[0]}:${JSON.stringify(config)}`);
        const status =
          typeof opts.status === "function"
            ? opts.status()
            : (opts.status ?? null);
        return { context: { slot: BigInt(1) }, value: [status] };
      },
    }),
  } as unknown as CustodyOpenCheckRpc;
  return { rpc, calls };
}
const vaultPda = key(7);
const createdAt = new Date(1_700_000_000_000).toISOString();
const later = 1_700_000_000_000 + CUSTODY_OPEN_ABANDON_AFTER_MS;

describe("a saved approval the network never opened (F006 discard)", () => {
  it("a vault on the network, even a tombstone, is present: never discardable", async () => {
    const { rpc, calls } = fakeRpc({ account: true });
    const intent = { vaultPda, signature: null, createdAt };
    expect(await checkCustodyOpenIntent(rpc, intent, { now: later })).toBe(
      "vault_present",
    );
    expect(calls).toEqual([`account:${vaultPda}`]);
  });
  it("no vault and no send result: pending until the bound since the later of creation and the last attempt, then never opened", async () => {
    const { rpc } = fakeRpc({ account: false });
    const intent = { vaultPda, signature: null, createdAt };
    expect(
      await checkCustodyOpenIntent(rpc, intent, { now: later - 1 }),
    ).toBe("pending");
    expect(await checkCustodyOpenIntent(rpc, intent, { now: later })).toBe(
      "never_opened",
    );
    expect(
      await checkCustodyOpenIntent(rpc, intent, {
        now: later,
        lastAttemptAt: later - 1,
      }),
    ).toBe("pending");
  });
  it("with a signature: a failed transaction means never opened at once, a running or unknown one is read by the bound", async () => {
    const intent = { vaultPda, signature, createdAt };
    const read = async (status: FakeStatus, now: number) => {
      const { rpc, calls } = fakeRpc({ account: false, status });
      const state = await checkCustodyOpenIntent(rpc, intent, { now });
      expect(calls[1]).toContain('"searchTransactionHistory":true');
      return state;
    };
    expect(
      await read({ err: { x: 1 }, confirmationStatus: "finalized" }, later - 1),
    ).toBe("never_opened");
    expect(
      await read({ err: { x: 1 }, confirmationStatus: "processed" }, later),
    ).toBe("pending");
    expect(
      await read({ err: null, confirmationStatus: "confirmed" }, later),
    ).toBe("pending");
    expect(await read(null, later - 1)).toBe("pending");
    expect(await read(null, later)).toBe("never_opened");
  });
  it("a network that cannot be read answers unknown", async () => {
    const { rpc } = fakeRpc({ account: false, fail: true });
    expect(
      await checkCustodyOpenIntent(
        rpc,
        { vaultPda, signature: null, createdAt },
        { now: later },
      ),
    ).toBe("unknown");
  });
  it("forgets only the exact saved approval: a changed or corrupt record stays", async () => {
    const input = setup();
    input.send.mockRejectedValueOnce(new Error("RPC disconnected"));
    await expect(openCustodyOnce(input)).rejects.toThrow("RPC disconnected");
    const intent = readCustodyOpenIntent(scope)!;
    expect(forgetCustodyOpenIntent({ ...intent, signature })).toBe(false);
    expect(
      forgetCustodyOpenIntent({ ...intent, createdAt: new Date(1).toISOString() }),
    ).toBe(false);
    expect(readCustodyOpenIntent(scope)).toEqual(intent);
    const storageKey = [...entries.keys()][0];
    const raw = entries.get(storageKey)!;
    entries.set(storageKey, "broken JSON");
    expect(forgetCustodyOpenIntent(intent)).toBe(false);
    expect(entries.get(storageKey)).toBe("broken JSON");
    entries.set(storageKey, raw);
    expect(forgetCustodyOpenIntent(intent)).toBe(true);
    expect(readCustodyOpenIntent(scope)).toBeNull();
    expect(forgetCustodyOpenIntent(intent)).toBe(false);
  });
  it("waits for the vault at finalized when the send result is unknown, and for the signature when it is known", async () => {
    let reads = 0;
    const appears = fakeRpc({ account: () => ++reads >= 3 });
    expect(
      await awaitCustodyOpenFinalized(
        appears.rpc,
        { vaultPda, signature: null },
        { timeoutMs: 1_000, pollMs: 1 },
      ),
    ).toBe("finalized");
    expect(reads).toBe(3);
    expect(
      await awaitCustodyOpenFinalized(
        fakeRpc({ account: false }).rpc,
        { vaultPda, signature: null },
        { timeoutMs: 10, pollMs: 2 },
      ),
    ).toBe("timeout");
    expect(
      await awaitCustodyOpenFinalized(
        fakeRpc({ account: false, fail: true }).rpc,
        { vaultPda, signature: null },
        { timeoutMs: 10, pollMs: 2 },
      ),
    ).toBe("unknown");
    const bySignature = fakeRpc({
      account: false,
      status: { err: null, confirmationStatus: "finalized" },
    });
    expect(
      await awaitCustodyOpenFinalized(
        bySignature.rpc,
        { vaultPda, signature },
        { timeoutMs: 10, pollMs: 2 },
      ),
    ).toBe("finalized");
    expect(bySignature.calls.every((c) => c.startsWith("status:"))).toBe(true);
    const failed = fakeRpc({
      account: false,
      status: { err: { x: 1 }, confirmationStatus: "confirmed" },
    });
    expect(
      await awaitCustodyOpenFinalized(
        failed.rpc,
        { vaultPda, signature },
        { timeoutMs: 10, pollMs: 2 },
      ),
    ).toBe("failed");
  });
});
