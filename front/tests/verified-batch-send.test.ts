// lib/verified-solana-client prepareAndSendAll ("Send to wallets", S6):
// every gate of prepareAndSend per transaction, one wallet-policy check, ONE
// Wallet Standard prompt for N transactions sharing a blockhash, each
// returned message compared with the one built, the journal written before
// any broadcast, every transaction sent at once (no 30 s settle wait inside
// the batch) — and one prompt per transaction when the wallet cannot sign
// them together, never after the user's refusal.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SolanaClient, TransactionPrepared, TransactionPrepareRequest, WalletSession } from "@solana/client";
import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
  type Transaction,
} from "@solana/kit";

const events = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/maintenance", async (original) => ({
  ...(await original<typeof import("@/lib/maintenance")>()),
  assertSiteWritable: vi.fn(async () => {
    events.push("maintenance");
  }),
}));
vi.mock("@/lib/transaction-wallet-policy", async (original) => ({
  ...(await original<typeof import("@/lib/transaction-wallet-policy")>()),
  requestTransactionWalletPolicy: vi.fn(async () => {
    events.push("authorize");
  }),
}));
vi.mock("@/lib/network-identity", async (original) => ({
  ...(await original<typeof import("@/lib/network-identity")>()),
  createNetworkVerifier: () => async () => {
    events.push("network");
  },
}));
const sim = vi.hoisted(() => ({ refuseAt: -1, count: 0 }));
vi.mock("@/lib/simulation-gate", async (original) => ({
  ...(await original<typeof import("@/lib/simulation-gate")>()),
  simulateMessage: vi.fn(async () => {
    const i = sim.count++;
    events.push("simulate");
    return i === sim.refuseAt
      ? { err: { InstructionError: [2, { Custom: 6005 }] }, logs: [], unitsConsumed: 1_000 }
      : { err: null, logs: [], unitsConsumed: 120_000 };
  }),
}));
const wallet = vi.hoisted(() => ({
  mode: "sign" as "sign" | "fewer" | "reject" | "change",
  calls: [] as Uint8Array[][],
}));
vi.mock("@/lib/wallet-standard-batch", async (original) => {
  const actual = await original<typeof import("@/lib/wallet-standard-batch")>();
  return {
    ...actual,
    signTransactionsWithWallet: vi.fn(async (input: { transactions: readonly Uint8Array[]; assertCurrent: () => void }) => {
      input.assertCurrent();
      events.push(`wallet.batch(${input.transactions.length})`);
      wallet.calls.push([...input.transactions]);
      if (wallet.mode === "reject") throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      if (wallet.mode === "fewer") throw new actual.BatchSigningUnsupportedError("the wallet returned 1 of 3 transactions");
      return input.transactions.map((bytes, i) => {
        const tx = getTransactionDecoder().decode(bytes);
        const messageBytes = wallet.mode === "change" && i === 1 ? Uint8Array.from([...tx.messageBytes].map((b, k) => (k === 5 ? b ^ 1 : b))) : tx.messageBytes;
        const signatures = Object.fromEntries(Object.keys(tx.signatures).map((k) => [k, new Uint8Array(64).fill(i + 1)]));
        return Uint8Array.from(getTransactionEncoder().encode({ messageBytes, signatures } as unknown as Transaction));
      });
    }),
  };
});

import { getBatchSender, withVerifiedTransactions, type BatchSigned } from "@/lib/verified-solana-client";
import { resetPriorityFeeCache } from "@/lib/priority-fee";
import { SimulationRefusedError } from "@/lib/simulation-gate";
import { signTransactionsWithWallet } from "@/lib/wallet-standard-batch";
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  decodeComputeBudgetInstruction,
  setComputeUnitLimitInstruction,
  setComputeUnitPriceInstruction,
} from "@/lib/compute-budget";

const WALLET = address("7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2");
const PROGRAM = address("FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS");
const ix = (tag: number): Instruction => ({ programAddress: PROGRAM, data: Uint8Array.of(tag) });

const fetchMock = vi.fn(async () => {
  events.push("fee");
  return Response.json({ ok: true, network: "devnet", microLamports: "5000", source: "helius", level: "High" });
});

function session(): WalletSession {
  return {
    account: { address: WALLET, publicKey: new Uint8Array(32) },
    connector: { id: "wallet-standard:test", name: "Test" },
    disconnect: vi.fn(async () => {}),
    signMessage: vi.fn(async () => new Uint8Array(64)),
  };
}

function fixture() {
  const current = session();
  let blockhashes = 0;
  const sent: string[] = [];
  const prepare = vi.fn(async (input: TransactionPrepareRequest) => {
    const lifetime = input.lifetime ?? { blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: BigInt(0) };
    // As the SDK compiles it: [limit?, price?, ...app].
    const prefix = [
      ...(input.computeUnitLimit !== undefined ? [setComputeUnitLimitInstruction(Number(input.computeUnitLimit))] : []),
      ...(input.computeUnitPrice !== undefined ? [setComputeUnitPriceInstruction(BigInt(input.computeUnitPrice))] : []),
    ];
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(WALLET, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      (m) => appendTransactionMessageInstructions([...prefix, ...input.instructions], m),
    );
    return { feePayer: WALLET, instructions: input.instructions, message, lifetime, version: 0 } as unknown as TransactionPrepared;
  });
  const sign = vi.fn(async (prepared: TransactionPrepared) => {
    events.push("wallet.single");
    const tx = compileTransaction(prepared.message as Parameters<typeof compileTransaction>[0]);
    return { ...tx, signatures: { [WALLET]: new Uint8Array(64).fill(9) } };
  });
  const rpc = {
    getLatestBlockhash: () => ({
      send: async () => {
        blockhashes += 1;
        events.push("blockhash");
        return { value: { blockhash: blockhash("4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"), lastValidBlockHeight: BigInt(1_000 + blockhashes) } };
      },
    }),
    sendTransaction: (wire: string) => ({
      send: async () => {
        events.push("send");
        sent.push(wire);
        return "sig";
      },
    }),
    getSignatureStatuses: () => ({
      send: async () => {
        events.push("settle");
        return { value: [{ err: null, confirmationStatus: "confirmed" }] };
      },
    }),
  };
  const transaction = { prepare, prepareAndSend: vi.fn(), sign, toWire: vi.fn(), send: vi.fn() };
  const client = {
    runtime: { rpc },
    transaction,
    helpers: { transaction },
    store: { getState: () => ({ wallet: { status: "connected", session: current } }) },
  } as unknown as SolanaClient;
  const guarded = withVerifiedTransactions(client, "devnet");
  return { client, guarded, sender: getBatchSender(guarded)!, prepare, sign, sent, blockhashes: () => blockhashes };
}

const requests = (count: number) => Array.from({ length: count }, (_, i) => ({ feePayer: WALLET, instructions: [ix(i + 1)] }));

beforeEach(() => {
  events.length = 0;
  sim.refuseAt = -1;
  sim.count = 0;
  wallet.mode = "sign";
  wallet.calls.length = 0;
  resetPriorityFeeCache();
  fetchMock.mockClear();
  vi.mocked(signTransactionsWithWallet).mockClear();
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  vi.stubGlobal("window", { dispatchEvent: () => true });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("prepareAndSendAll: one prompt for N transactions", () => {
  it("runs every gate per transaction, then one policy check, ONE wallet call with N inputs, the journal, then N sends", async () => {
    const f = fixture();
    const journal: BatchSigned[][] = [];
    const result = await f.sender.prepareAndSendAll(requests(3), {
      onSigned: (signed) => {
        events.push("journal");
        journal.push([...signed]);
      },
    });
    expect(result).toMatchObject({ prompts: 1, mode: "batch", fallbackReason: null });
    expect(result.outcomes.map((o) => o.sent)).toEqual([true, true, true]);
    expect(signTransactionsWithWallet).toHaveBeenCalledOnce();
    expect(wallet.calls[0]).toHaveLength(3);
    // Gates and simulations for all three before the one prompt; the journal before any send; no settle wait.
    expect(events.filter((e) => e === "simulate")).toHaveLength(3);
    expect(events.filter((e) => e === "authorize")).toHaveLength(1);
    expect(events.indexOf("authorize")).toBeLessThan(events.indexOf("wallet.batch(3)"));
    expect(events.lastIndexOf("simulate")).toBeLessThan(events.indexOf("wallet.batch(3)"));
    expect(events.indexOf("journal")).toBeLessThan(events.indexOf("send"));
    expect(events.slice(events.indexOf("journal"))).toEqual(["journal", "send", "send", "send"]);
    expect(events).not.toContain("settle");
    // One shared blockhash; each journalled signature and its last valid block height.
    expect(f.blockhashes()).toBe(1);
    expect(journal).toHaveLength(1);
    expect(journal[0].map((s) => s.index)).toEqual([0, 1, 2]);
    expect(new Set(journal[0].map((s) => s.lastValidBlockHeight.toString()))).toEqual(new Set(["1001"]));
    expect(new Set(journal[0].map((s) => s.signature)).size).toBe(3);
    expect(f.sent).toHaveLength(3);
    // The wallet saw [limit (the gate's estimate), price, app]: the compute budget first.
    const first = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(wallet.calls[0][0]).messageBytes);
    const programs = first.instructions.map((i) => first.staticAccounts[i.programAddressIndex]);
    expect(programs).toEqual([COMPUTE_BUDGET_PROGRAM_ADDRESS, COMPUTE_BUDGET_PROGRAM_ADDRESS, PROGRAM]);
    expect(decodeComputeBudgetInstruction({ programAddress: programs[0], data: first.instructions[0].data })).toEqual({ kind: "limit", units: 200_000 });
  });

  it("waits for the previous send once before a batch, never between the batch's own sends", async () => {
    const f = fixture();
    await f.sender.prepareAndSendAll(requests(2), { onSigned: () => {} });
    events.length = 0;
    await f.sender.prepareAndSendAll(requests(2), { onSigned: () => {} });
    expect(events.filter((e) => e === "settle")).toHaveLength(1);
    expect(events.indexOf("settle")).toBeLessThan(events.indexOf("wallet.batch(2)"));
  });

  it("falls back to one prompt per transaction when the wallet returns fewer (or cannot sign them together)", async () => {
    const f = fixture();
    wallet.mode = "fewer";
    const order: string[] = [];
    const result = await f.sender.prepareAndSendAll(requests(3), {
      onSigned: (signed) => void order.push(`journal:${signed.map((s) => s.index).join(",")}`),
      onPrompt: (p) => order.push(`prompt:${p.mode}:${p.index}`),
    });
    expect(result).toMatchObject({ prompts: 3, mode: "per-transaction" });
    expect(result.fallbackReason).toMatch(/returned 1 of 3/);
    expect(f.sign).toHaveBeenCalledTimes(3);
    expect(order).toEqual(["prompt:batch:0", "prompt:per-transaction:0", "journal:0", "prompt:per-transaction:1", "journal:1", "prompt:per-transaction:2", "journal:2"]);
    expect(result.outcomes.every((o) => o.sent)).toBe(true);
    // A fresh blockhash each (signing one by one takes a while), after the batch's own.
    expect(f.blockhashes()).toBe(4);
  });

  it("falls back when the wallet changed a message, and records what it changed", async () => {
    const f = fixture();
    wallet.mode = "change";
    const result = await f.sender.prepareAndSendAll(requests(2), { onSigned: () => {} });
    expect(result.mode).toBe("per-transaction");
    expect(result.fallbackReason).toMatch(/transaction 2/);
    expect(f.sign).toHaveBeenCalledTimes(2);
  });

  it("a refusal is the user's answer: nothing is signed one by one and nothing is sent", async () => {
    const f = fixture();
    wallet.mode = "reject";
    const onSigned = vi.fn();
    await expect(f.sender.prepareAndSendAll(requests(2), { onSigned })).rejects.toMatchObject({ code: 4001 });
    expect(f.sign).not.toHaveBeenCalled();
    expect(onSigned).not.toHaveBeenCalled();
    expect(f.sent).toHaveLength(0);
  });

  it("a transaction the simulation refuses stops the batch before any prompt", async () => {
    const f = fixture();
    sim.refuseAt = 1;
    await expect(f.sender.prepareAndSendAll(requests(3), { onSigned: () => {} })).rejects.toBeInstanceOf(SimulationRefusedError);
    expect(signTransactionsWithWallet).not.toHaveBeenCalled();
    expect(events).not.toContain("authorize");
  });

  it("a journal that cannot be written stops the broadcast", async () => {
    const f = fixture();
    await expect(
      f.sender.prepareAndSendAll(requests(2), {
        onSigned: () => {
          throw new Error("storage full");
        },
      }),
    ).rejects.toThrow("storage full");
    expect(f.sent).toHaveLength(0);
  });

  it("'per-transaction' asks once per transaction from the start", async () => {
    const f = fixture();
    const result = await f.sender.prepareAndSendAll(requests(2), { mode: "per-transaction", onSigned: () => {} });
    expect(result).toMatchObject({ prompts: 2, mode: "per-transaction", fallbackReason: null });
    expect(signTransactionsWithWallet).not.toHaveBeenCalled();
  });

  it("exists only on the app's verified client", () => {
    const f = fixture();
    expect(getBatchSender(f.guarded)).not.toBeNull();
    expect(getBatchSender(f.client)).toBeNull();
  });
});
