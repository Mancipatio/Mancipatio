// lib/wallet-chain (the chain a wallet is told), lib/wallet-changes (what a
// wallet changed while signing), the guarded session that records it, and
// lib/tx-error's wording of a pre-execution refusal by the network.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WalletSession } from "@solana/client";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
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
  judgeWalletRewrite,
  noteWalletChange,
  recentWalletChange,
  WALLET_CHANGE_TTL_MS,
} from "@/lib/wallet-changes";
import { guardWalletSession } from "@/lib/guarded-wallet-connectors";
import { explainNetworkRefusal, explainSendError } from "@/lib/tx-error";
import { setComputeUnitLimitInstruction, setComputeUnitPriceInstruction } from "@/lib/compute-budget";
import { priorityFeeCap } from "@/lib/priority-fee";

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

  it("clears an older note when the wallet signs and sends itself", async () => {
    noteWalletChange("stale");
    const source: WalletSession = {
      account: { address: WALLET, publicKey: new Uint8Array(32) },
      connector: { id: "fixture", name: "Fixture" },
      disconnect: vi.fn(async () => {}),
      sendTransaction: vi.fn(async () => "signature" as never),
    };
    const guarded: WalletSession = guardWalletSession(source, () => guarded);
    await guarded.sendTransaction!(tx([app]) as never);
    expect(recentWalletChange()).toBeNull();
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

  it("names a refusal it has no words for, including variants newer than kit", () => {
    expect(explainNetworkRefusal(preflightFailure("AccountInUse"))).toBe(
      "The network refused the transaction before running it (AccountInUse).",
    );
    expect(explainNetworkRefusal(preflightFailure("SomeFutureRefusal"))).toBe(
      "The network refused the transaction before running it (SomeFutureRefusal).",
    );
  });

  it("gives InvalidLoadedAccountsDataSizeLimit its own wording", () => {
    expect(explainNetworkRefusal(preflightFailure("InvalidLoadedAccountsDataSizeLimit"))).toMatch(
      /limit of zero or an invalid one \(InvalidLoadedAccountsDataSizeLimit\)/,
    );
  });

  it("a note explains one failure only", () => {
    noteWalletChange("the wallet replaced its blockhash before signing");
    expect(explainNetworkRefusal(preflightFailure("BlockhashNotFound"))).toMatch(/Note: the wallet replaced its blockhash before signing\.$/);
    expect(explainNetworkRefusal(preflightFailure("BlockhashNotFound"))).not.toMatch(/Note:/);
  });

  it("an InstructionError (a program failure) is not a network refusal", () => {
    const programFailure = getSolanaErrorFromJsonRpcError({
      code: -32002,
      message: "Transaction simulation failed",
      data: { accounts: null, err: { InstructionError: [0, { Custom: 1 }] }, logs: ["Program log: Error: nope"], unitsConsumed: 10 },
    });
    expect(explainNetworkRefusal(programFailure)).toBeNull();
    expect(explainSendError(programFailure)).toMatch(/Error: nope/);
  });

  it("program logs, when there are any, win over a refusal code", () => {
    const withLogs = getSolanaErrorFromJsonRpcError({
      code: -32002,
      message: "Transaction simulation failed",
      data: { accounts: null, err: "AccountInUse", logs: ["Program log: Error: the real reason"], unitsConsumed: 0 },
    });
    expect(explainSendError(withLogs)).toMatch(/Error: the real reason/);
  });
});

describe("judgeWalletRewrite: only the compute budget may change, within bounds", () => {
  const OTHER = address("GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi");
  const appWithAccounts: Instruction = {
    programAddress: PROGRAM,
    accounts: [
      { address: WALLET, role: AccountRole.WRITABLE_SIGNER },
      { address: OTHER, role: AccountRole.WRITABLE },
    ],
    data: new Uint8Array([7, 1, 0, 0]),
  };
  const built = tx([setComputeUnitLimitInstruction(200_000), setComputeUnitPriceInstruction(BigInt(100_000)), appWithAccounts]).messageBytes;
  const mainnet = { maxComputeUnitPrice: priorityFeeCap("mainnet"), minComputeUnitLimit: 120_000 };
  const judge = (instructions: Instruction[], blockhash: Blockhash = HASH_A) => judgeWalletRewrite(built, tx(instructions, blockhash).messageBytes, mainnet);

  it("the mainnet cap is the priority-fee policy's (2 lamports per CU)", () => {
    expect(priorityFeeCap("mainnet")).toBe(BigInt(2_000_000));
    expect(priorityFeeCap("devnet")).toBe(BigInt(100_000));
    expect(priorityFeeCap("localnet")).toBe(BigInt(0));
  });

  it("identical bytes are identical", () => {
    expect(judgeWalletRewrite(built, built, mainnet)).toEqual({ kind: "identical" });
  });

  it("accepts Phantom's mainnet rewrite: its own limit and price, reordered, up to the cap", () => {
    const verdict = judge([setComputeUnitPriceInstruction(BigInt(2_000_000)), setComputeUnitLimitInstruction(120_000), appWithAccounts]);
    expect(verdict).toMatchObject({ kind: "compute-budget", units: 120_000, microLamports: BigInt(2_000_000) });
    expect((verdict as { change: string }).change).toMatch(
      /\[SetComputeUnitLimit\(200000\), SetComputeUnitPrice\(100000\)\] → \[SetComputeUnitPrice\(2000000\), SetComputeUnitLimit\(120000\)\]/,
    );
  });

  it("accepts a wallet that drops the price (no fee), keeping a sufficient limit", () => {
    expect(judge([setComputeUnitLimitInstruction(400_000), appWithAccounts])).toMatchObject({ kind: "compute-budget", microLamports: BigInt(0) });
  });

  it("refuses a price above the cap and a limit below the need, naming the numbers", () => {
    expect(judge([setComputeUnitLimitInstruction(200_000), setComputeUnitPriceInstruction(BigInt(2_000_001)), appWithAccounts])).toMatchObject({
      kind: "refused",
      change: expect.stringMatching(/priority fee to 2000001 .*cap of 2000000/),
    });
    expect(judge([setComputeUnitLimitInstruction(119_999), setComputeUnitPriceInstruction(BigInt(1)), appWithAccounts])).toMatchObject({
      kind: "refused",
      change: expect.stringMatching(/limit to 119999, below the 120000/),
    });
  });

  it("without a simulated need, the built limit is the floor; a removed limit is refused", () => {
    const noNeed = { ...mainnet, minComputeUnitLimit: null };
    const lower = tx([setComputeUnitLimitInstruction(199_999), appWithAccounts]).messageBytes;
    expect(judgeWalletRewrite(built, lower, noNeed)).toMatchObject({ kind: "refused", change: expect.stringMatching(/below the 200000/) });
    expect(judge([setComputeUnitPriceInstruction(BigInt(5)), appWithAccounts])).toMatchObject({
      kind: "refused",
      change: expect.stringMatching(/removed the compute unit limit/),
    });
  });

  it("refuses a second limit or price, and any other compute-budget instruction", () => {
    expect(judge([setComputeUnitLimitInstruction(200_000), setComputeUnitPriceInstruction(BigInt(1)), setComputeUnitPriceInstruction(BigInt(2)), appWithAccounts])).toMatchObject({
      kind: "refused",
      change: expect.stringMatching(/price twice/),
    });
    const loadedData: Instruction = { programAddress: setComputeUnitLimitInstruction(0).programAddress, data: new Uint8Array([4, 0, 0, 1, 0]) };
    expect(judge([loadedData, setComputeUnitLimitInstruction(200_000), appWithAccounts])).toMatchObject({
      kind: "refused",
      change: expect.stringMatching(/does not accept \(ComputeBudget\.SetLoadedAccountsDataSizeLimit\)/),
    });
  });

  it("refuses everything else, whatever the compute budget: blockhash, instructions, data, accounts, roles, signers", () => {
    const fee = [setComputeUnitPriceInstruction(BigInt(1_000)), setComputeUnitLimitInstruction(150_000)];
    const cases: [Instruction[], Blockhash, RegExp][] = [
      [[...fee, appWithAccounts], HASH_B, /replaced its blockhash/],
      [[...fee, appWithAccounts, app], HASH_A, /changed its instructions/],
      [[...fee, { ...appWithAccounts, data: new Uint8Array([7, 2, 0, 0]) }], HASH_A, /changed the data of instruction 3/],
      [[...fee, { ...appWithAccounts, accounts: [appWithAccounts.accounts![0], { address: address("4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"), role: AccountRole.WRITABLE }] }], HASH_A, /changed the accounts of instruction 3/],
      [[...fee, { ...appWithAccounts, accounts: [appWithAccounts.accounts![0], { address: OTHER, role: AccountRole.READONLY }] }], HASH_A, /changed the accounts of instruction 3/],
      [[...fee, { ...appWithAccounts, accounts: [appWithAccounts.accounts![0], { address: OTHER, role: AccountRole.WRITABLE_SIGNER }] }], HASH_A, /changed the accounts of instruction 3/],
      [[...fee, appWithAccounts, { programAddress: PROGRAM, accounts: [{ address: address("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"), role: AccountRole.WRITABLE }], data: new Uint8Array([7, 1, 0, 0]) }], HASH_A, /changed its instructions/],
    ];
    for (const [instructions, blockhash, reason] of cases) {
      expect(judge(instructions, blockhash)).toMatchObject({ kind: "refused", change: expect.stringMatching(reason) });
    }
  });

  it("a wallet's recompile that only reorders accounts within their roles is the same transaction", () => {
    const decoded = getCompiledTransactionMessageDecoder().decode(built);
    const n = decoded.staticAccounts.length;
    // The last two static accounts are both read-only non-signers (the two programs): swap them.
    const swap = (i: number) => (i === n - 1 ? n - 2 : i === n - 2 ? n - 1 : i);
    const reordered = getCompiledTransactionMessageEncoder().encode({
      ...decoded,
      staticAccounts: decoded.staticAccounts.map((_, i) => decoded.staticAccounts[swap(i)]),
      instructions: decoded.instructions.map((ix) => ({
        ...ix,
        programAddressIndex: swap(ix.programAddressIndex),
        ...(ix.accountIndices ? { accountIndices: ix.accountIndices.map(swap) } : {}),
      })),
    } as typeof decoded);
    expect(judgeWalletRewrite(built, reordered, mainnet)).toMatchObject({ kind: "compute-budget", units: 200_000 });
  });

  it("refuses a fee payer change and an unreadable message", () => {
    const otherPayer = compileTransaction(
      pipe(
        createTransactionMessage({ version: "legacy" }),
        (m) => setTransactionMessageFeePayer(OTHER, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: HASH_A, lastValidBlockHeight: BigInt(1) }, m),
        (m) => appendTransactionMessageInstructions([setComputeUnitLimitInstruction(200_000), appWithAccounts], m),
      ),
    ).messageBytes;
    expect(judgeWalletRewrite(built, otherPayer, mainnet)).toMatchObject({ kind: "refused", change: expect.stringMatching(/fee payer/) });
    expect(judgeWalletRewrite(built, new Uint8Array([1, 2, 3]), mainnet)).toMatchObject({ kind: "refused" });
  });
});
