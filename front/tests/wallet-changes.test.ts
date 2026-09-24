// lib/wallet-chain (the chain a wallet is told), lib/wallet-changes (what a
// wallet changed while signing), the guarded session that records it, and
// lib/tx-error's wording of a pre-execution refusal by the network.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WalletSession } from "@solana/client";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getSolanaErrorFromJsonRpcError,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  SolanaError,
  SOLANA_ERROR__INSTRUCTION_PLANS__FAILED_TO_EXECUTE_TRANSACTION_PLAN,
  type Blockhash,
  type Instruction,
} from "@solana/kit";
import { walletChain, walletConnectorOverrides } from "@/lib/wallet-chain";
import {
  clearWalletChange,
  describeWalletChange,
  noteWalletChange,
  recentWalletChange,
  WALLET_CHANGE_TTL_MS,
} from "@/lib/wallet-changes";
import { guardWalletSession } from "@/lib/guarded-wallet-connectors";
import { explainNetworkRefusal, explainSendError } from "@/lib/tx-error";
import { setComputeUnitLimitInstruction, setComputeUnitPriceInstruction } from "@/lib/compute-budget";

const WALLET = address("6AnFbinF7X12mACTVEGfjWZyzYGAShEscAB5UgV3vHsP");
const PROGRAM = address("FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS");
const HASH_A = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k" as Blockhash;
const HASH_B = "4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn" as Blockhash;
const app: Instruction = { programAddress: PROGRAM, data: new Uint8Array([1]) };

function tx(instructions: Instruction[], blockhash: Blockhash = HASH_A) {
  return compileTransaction(
    pipe(
      createTransactionMessage({ version: "legacy" }),
      (m) => setTransactionMessageFeePayer(WALLET, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: BigInt(1) }, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ),
  );
}

afterEach(() => {
  clearWalletChange();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("wallet chain", () => {
  it("maps every network to its Wallet Standard chain", () => {
    expect(walletChain("mainnet")).toBe("solana:mainnet");
    expect(walletChain("devnet")).toBe("solana:devnet");
    expect(walletChain("testnet")).toBe("solana:testnet");
    expect(walletChain("localnet")).toBe("solana:localnet");
    expect(() => walletChain("mainnet-beta" as never)).toThrow(/Unknown network/);
  });

  it("sets defaultChain only for a wallet that lists the chain", () => {
    const overrides = walletConnectorOverrides("devnet");
    expect(overrides({ chains: ["solana:mainnet", "solana:devnet"] })).toEqual({ defaultChain: "solana:devnet" });
    expect(overrides({ chains: ["solana:mainnet"] })).toBeUndefined();
    expect(walletConnectorOverrides("localnet")({ chains: ["solana:mainnet", "solana:devnet"] })).toBeUndefined();
  });
});

describe("describeWalletChange", () => {
  it("is null for an unchanged message or a missing one", () => {
    const t = tx([setComputeUnitLimitInstruction(200_000), setComputeUnitPriceInstruction(BigInt(1000)), app]);
    expect(describeWalletChange(t.messageBytes, Uint8Array.from(t.messageBytes))).toBeNull();
    expect(describeWalletChange(undefined, t.messageBytes)).toBeNull();
  });

  it("names added compute-budget instructions", () => {
    const before = tx([setComputeUnitPriceInstruction(BigInt(1000)), app, setComputeUnitLimitInstruction(200_000)]);
    const after = tx([
      setComputeUnitLimitInstruction(50_000),
      setComputeUnitPriceInstruction(BigInt(90_000)),
      setComputeUnitPriceInstruction(BigInt(1000)),
      app,
      setComputeUnitLimitInstruction(200_000),
    ]);
    const text = describeWalletChange(before.messageBytes, after.messageBytes);
    expect(text).toBe(
      "the wallet changed its instructions [SetComputeUnitPrice(1000), FJs1…mYxS, SetComputeUnitLimit(200000)] → " +
        "[SetComputeUnitLimit(50000), SetComputeUnitPrice(90000), SetComputeUnitPrice(1000), FJs1…mYxS, SetComputeUnitLimit(200000)] before signing",
    );
  });

  it("names a replaced blockhash and other compute-budget kinds", () => {
    const loadedLimit: Instruction = { programAddress: setComputeUnitLimitInstruction(1).programAddress, data: new Uint8Array([4, 0, 0, 1, 0]) };
    const before = tx([app]);
    const after = tx([loadedLimit, app], HASH_B);
    expect(describeWalletChange(before.messageBytes, after.messageBytes)).toBe(
      "the wallet replaced its blockhash and changed its instructions [FJs1…mYxS] → [ComputeBudget.SetLoadedAccountsDataSizeLimit, FJs1…mYxS] before signing",
    );
  });

  it("does not throw on bytes that are not a message", () => {
    expect(describeWalletChange(new Uint8Array([1, 2]), new Uint8Array([3]))).toBe("the wallet changed the transaction before signing it");
  });

  it("keeps the latest note for its time to live", () => {
    noteWalletChange("x", 1_000);
    expect(recentWalletChange(1_000 + WALLET_CHANGE_TTL_MS)).toBe("x");
    expect(recentWalletChange(1_001 + WALLET_CHANGE_TTL_MS)).toBeNull();
    clearWalletChange();
    expect(recentWalletChange(1_000)).toBeNull();
  });
});

describe("the guarded session records what the wallet changed", () => {
  function sessionReturning(signed: ReturnType<typeof tx>): WalletSession {
    return {
      account: { address: WALLET, publicKey: new Uint8Array(32) },
      connector: { id: "fixture", name: "Fixture" },
      disconnect: vi.fn(async () => {}),
      signTransaction: vi.fn(async () => signed as never),
    };
  }

  it("notes and logs a modified message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handed = tx([setComputeUnitPriceInstruction(BigInt(1000)), app]);
    const returned = tx([setComputeUnitLimitInstruction(9), setComputeUnitPriceInstruction(BigInt(1000)), app]);
    const guarded: WalletSession = guardWalletSession(sessionReturning(returned), () => guarded);
    await expect(guarded.signTransaction!(handed as never)).resolves.toBe(returned);
    expect(recentWalletChange()).toMatch(/^the wallet changed its instructions/);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[wallet\] the wallet changed its instructions/));
  });

  it("clears an older note when the wallet signs unchanged", async () => {
    noteWalletChange("stale");
    const handed = tx([app]);
    const guarded: WalletSession = guardWalletSession(sessionReturning(handed), () => guarded);
    await guarded.signTransaction!(handed as never);
    expect(recentWalletChange()).toBeNull();
  });
});

describe("a pre-execution refusal by the network", () => {
  // What kit builds from the RPC's -32002 answer, wrapped by the plan executor.
  function preflightFailure(err: unknown) {
    const preflight = getSolanaErrorFromJsonRpcError({
      code: -32002,
      message: "Transaction simulation failed",
      data: { accounts: null, err, logs: [], unitsConsumed: 0, loadedAccountsDataSize: 0, returnData: null },
    });
    return new SolanaError(SOLANA_ERROR__INSTRUCTION_PLANS__FAILED_TO_EXECUTE_TRANSACTION_PLAN, {
      cause: preflight,
      transactionPlanResult: { kind: "single", status: { kind: "failed", error: preflight } },
    } as never);
  }

  it("names BlockhashNotFound for the build's network", () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    expect(explainSendError(preflightFailure("BlockhashNotFound"))).toMatch(
      /^The network did not recognise the transaction's blockhash \(BlockhashNotFound\).*another network than devnet/,
    );
  });

  it("names DuplicateInstruction and adds what the wallet changed", () => {
    noteWalletChange("the wallet changed its instructions [a] → [b, a] before signing");
    expect(explainSendError(preflightFailure({ DuplicateInstruction: 2 }))).toBe(
      "The transaction carries the same compute-budget instruction twice (DuplicateInstruction), usually because the wallet added its own priority fee to the app's. " +
        "Note: the wallet changed its instructions [a] → [b, a] before signing.",
    );
  });

  it("falls back to the code for a refusal it has no words for", () => {
    expect(explainNetworkRefusal(preflightFailure("AccountInUse"))).toBe(
      "The network refused the transaction before running it (transaction error #7050001).",
    );
  });

  it("leaves program failures (with logs) to the existing explanation", () => {
    const programFailure = getSolanaErrorFromJsonRpcError({
      code: -32002,
      message: "Transaction simulation failed",
      data: { accounts: null, err: { InstructionError: [0, { Custom: 1 }] }, logs: ["Program log: Error: nope"], unitsConsumed: 10 },
    });
    expect(explainNetworkRefusal(programFailure)).toBeNull();
    expect(explainSendError(programFailure)).toMatch(/Error: nope/);
  });
});
