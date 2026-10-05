// lib/verified-solana-client prepareAndSendAll ("Send to wallets", S6):
// every gate of prepareAndSend per transaction, one wallet-policy check, ONE
// Wallet Standard prompt for N transactions sharing a blockhash, each
// returned message compared with the one built, the journal written before
// any broadcast, every transaction sent at once (no 30 s settle wait inside
// the batch) — and one prompt per transaction when the wallet cannot sign
// them together or guarded any of several, never after the user's refusal,
// each signed only once the previous one is confirmed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SolanaClient, TransactionPrepared, TransactionPrepareRequest, WalletSession } from "@solana/client";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  decompileTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SolanaError,
  type Address,
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
const sim = vi.hoisted(() => ({ refuseAt: -1, count: 0, units: 120_000 }));
vi.mock("@/lib/simulation-gate", async (original) => ({
  ...(await original<typeof import("@/lib/simulation-gate")>()),
  simulateMessage: vi.fn(async () => {
    const i = sim.count++;
    events.push("simulate");
    return i === sim.refuseAt
      ? { err: { InstructionError: [2, { Custom: 6005 }] }, logs: [], unitsConsumed: 1_000 }
      : { err: null, logs: [], unitsConsumed: sim.units };
  }),
}));
const wallet = vi.hoisted(() => ({
  mode: "sign" as "sign" | "fewer" | "reject" | "change",
  calls: [] as Uint8Array[][],
  // What the wallet does to each message before signing it (Phantom on mainnet: Lighthouse assertions added).
  rewrite: null as null | ((messageBytes: Uint8Array, index: number) => Uint8Array),
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
        const messageBytes =
          wallet.mode === "change" && i === 1 ? Uint8Array.from([...tx.messageBytes].map((b, k) => (k === 5 ? b ^ 1 : b)))
          : wallet.rewrite ? wallet.rewrite(Uint8Array.from(tx.messageBytes), i)
          : tx.messageBytes;
        const signatures = Object.fromEntries(Object.keys(tx.signatures).map((k) => [k, new Uint8Array(64).fill(i + 1)]));
        return Uint8Array.from(getTransactionEncoder().encode({ messageBytes, signatures } as unknown as Transaction));
      });
    }),
  };
});

import {
  BATCH_EXPIRY_MARGIN_BLOCKS,
  BLOCKHASH_LIFETIME_BLOCKS,
  EarlierTransactionUnconfirmedError,
  getBatchSender,
  MS_PER_BLOCK,
  remembersSignSeparately,
  SignedTransactionChangedError,
  SIGNING_TOO_SLOW,
  transactionId,
  verifySignedBatch,
  WALLET_STATE_GUARDS,
  withVerifiedTransactions,
  type BatchSigned,
  type BatchSignedInfo,
} from "@/lib/verified-solana-client";
import { resetPriorityFeeCache } from "@/lib/priority-fee";
import { SimulationRefusedError } from "@/lib/simulation-gate";
import { TransactionWalletChangedError } from "@/lib/transaction-wallet-policy";
import { BatchSigningUnsupportedError, signTransactionsWithWallet } from "@/lib/wallet-standard-batch";
import { DISTRIBUTION_GUARD_HEADROOM_UNITS, LIGHTHOUSE_PROGRAM_ADDRESS } from "@/lib/wallet-changes";
import {
  createPendingAuditWriter,
  journalThenPendingAudits,
  PENDING_AUDIT_WAIT_MS,
  type DistributionAuditRow,
} from "@/lib/distribution-audit-writer";
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

type SignatureStatus = { err: unknown; confirmationStatus: string } | null;

function fixture(
  opts: {
    heightAfterSigning?: number;
    /** Called with each broadcast wire transaction before it is accepted; throwing is the node refusing it. */
    onSend?: (wire: string) => void;
    /** The network's status of a signature (default: confirmed); throwing is an RPC that cannot answer. */
    status?: (signature: string) => SignatureStatus;
  } = {},
) {
  const current = session();
  let blockhashes = 0;
  const sent: string[] = [];
  /** The signatures of each getSignatureStatuses call, in order. */
  const statusCalls: string[][] = [];
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
    // Read once the wallet returns a batch: its blockhash must still have room to land.
    getBlockHeight: (o: { commitment: string }) => ({
      send: async () => {
        events.push(`height:${o.commitment}`);
        return BigInt(opts.heightAfterSigning ?? 900);
      },
    }),
    sendTransaction: (wire: string) => ({
      send: async () => {
        events.push("send");
        opts.onSend?.(wire);
        sent.push(wire);
        return "sig";
      },
    }),
    getSignatureStatuses: (signatures: readonly string[]) => ({
      send: async () => {
        events.push("settle");
        statusCalls.push([...signatures]);
        return { value: signatures.map((s) => (opts.status ? opts.status(s) : { err: null, confirmationStatus: "confirmed" })) };
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
  return { client, guarded, sender: getBatchSender(guarded)!, prepare, sign, sent, statusCalls, blockhashes: () => blockhashes };
}

const requests = (count: number) => Array.from({ length: count }, (_, i) => ({ feePayer: WALLET, instructions: [ix(i + 1)] }));

beforeEach(() => {
  events.length = 0;
  sim.refuseAt = -1;
  sim.count = 0;
  sim.units = 120_000;
  wallet.mode = "sign";
  wallet.calls.length = 0;
  wallet.rewrite = null;
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
    // The block height is read after the wallet returned, before the journal.
    expect(events.slice(events.indexOf("wallet.batch(3)"))).toEqual(["wallet.batch(3)", "height:confirmed", "journal", "send", "send", "send"]);
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

  it("a batch that outlasted its blockhash (a Ledger confirming each) is never journalled or sent: fresh-blockhash signing one by one", async () => {
    // The batch's blockhash is valid up to 1001; 980 + the margin is past it.
    const f = fixture({ heightAfterSigning: 980 });
    const journal: BatchSigned[][] = [];
    const result = await f.sender.prepareAndSendAll(requests(2), { onSigned: (signed) => void journal.push([...signed]) });
    expect(result).toMatchObject({ mode: "per-transaction", prompts: 2 });
    expect(result.fallbackReason).toMatch(/took too long/);
    expect(f.sign).toHaveBeenCalledTimes(2);
    // Only the per-transaction signatures were journalled, each with its own fresh blockhash.
    expect(journal.map((j) => j.map((s) => s.lastValidBlockHeight.toString()))).toEqual([["1002"], ["1003"]]);
    expect(f.sent).toHaveLength(2);
  });

  describe("per transaction: every returned message is compared with the one built", () => {
    const changedBlockhash = async (prepared: TransactionPrepared) => {
      events.push("wallet.single");
      const swapped = setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash("GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi"), lastValidBlockHeight: BigInt(9_999) },
        prepared.message as Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[1],
      );
      const tx = compileTransaction(swapped as unknown as Parameters<typeof compileTransaction>[0]);
      return { ...tx, signatures: { [WALLET]: new Uint8Array(64).fill(7) } } as never;
    };

    it("a wallet that swapped the blockhash: refused before the journal, nothing sent", async () => {
      const f = fixture();
      f.sign.mockImplementationOnce(changedBlockhash);
      const onSigned = vi.fn();
      const error = await f.sender.prepareAndSendAll(requests(2), { mode: "per-transaction", onSigned }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SignedTransactionChangedError);
      expect((error as Error).message).toMatch(/replaced its blockhash .*transaction 1 of 2.*not sent/);
      expect(onSigned).not.toHaveBeenCalled();
      expect(f.sent).toHaveLength(0);
    });

    it("after the batch fell back on a changed message, a changed one-by-one signature is refused too", async () => {
      const f = fixture();
      wallet.mode = "change";
      f.sign.mockImplementation(changedBlockhash);
      await expect(f.sender.prepareAndSendAll(requests(2), { onSigned: () => {} })).rejects.toBeInstanceOf(SignedTransactionChangedError);
      expect(f.sent).toHaveLength(0);
    });

    it("once some were sent, a changed one stops the run there: the rest are reported unsent", async () => {
      const f = fixture();
      f.sign.mockImplementationOnce(async (prepared: TransactionPrepared) => {
        const tx = compileTransaction(prepared.message as Parameters<typeof compileTransaction>[0]);
        return { ...tx, signatures: { [WALLET]: new Uint8Array(64).fill(9) } };
      });
      f.sign.mockImplementationOnce(changedBlockhash);
      const signed: number[] = [];
      const result = await f.sender.prepareAndSendAll(requests(3), {
        mode: "per-transaction",
        onSigned: (s) => void signed.push(...s.map((x) => x.index)),
      });
      expect(signed).toEqual([0]);
      expect(result.outcomes.map((o) => o.sent)).toEqual([true, false, false]);
      expect(result.outcomes[1].error).toBeInstanceOf(SignedTransactionChangedError);
      expect(f.sign).toHaveBeenCalledTimes(2);
      expect(f.sent).toHaveLength(1);
    });
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

  describe("per transaction: the next one is signed only once the previous one is confirmed", () => {
    // A wallet simulates a transaction when it is asked to sign it (Phantom
    // guards the fee payer's balance as that simulation saw it).
    const walletAndNetwork = () => events.filter((e) => e === "wallet.single" || e === "send" || e === "settle");

    it("waits for each transaction before the next prompt (not after the last)", async () => {
      const f = fixture();
      const result = await f.sender.prepareAndSendAll(requests(3), { mode: "per-transaction", onSigned: () => {} });
      expect(result.outcomes.map((o) => o.sent)).toEqual([true, true, true]);
      expect(walletAndNetwork()).toEqual(["wallet.single", "send", "settle", "wallet.single", "send", "settle", "wallet.single", "send"]);
    });

    it("a previous transaction that failed on the network stops the run: the rest are not signed", async () => {
      const f = fixture({ status: () => ({ err: { InstructionError: [4, { Custom: 6001 }] }, confirmationStatus: "confirmed" }) });
      const signed: number[] = [];
      const result = await f.sender.prepareAndSendAll(requests(3), { mode: "per-transaction", onSigned: (s) => void signed.push(...s.map((x) => x.index)) });
      expect(signed).toEqual([0]);
      expect(f.sign).toHaveBeenCalledOnce();
      expect(result.outcomes.map((o) => o.sent)).toEqual([true, false, false]);
      expect(result.outcomes[0].error).toBeNull();
      expect(result.outcomes[1].error).toBeInstanceOf(EarlierTransactionUnconfirmedError);
      expect((result.outcomes[1].error as Error).message).toBe(
        "Transaction 1 of 3 failed on the network (nothing of it moved), so the ones after it were not signed.",
      );
      expect(result.outcomes[2].error).toBe(result.outcomes[1].error);
    });

    it("a previous transaction the network cannot confirm stops the run too", async () => {
      const f = fixture({
        status: () => {
          throw new Error("RPC unavailable");
        },
      });
      const result = await f.sender.prepareAndSendAll(requests(2), { mode: "per-transaction", onSigned: () => {} });
      expect(f.sign).toHaveBeenCalledOnce();
      expect(result.outcomes.map((o) => o.sent)).toEqual([true, false]);
      expect((result.outcomes[1].error as Error).message).toBe("Transaction 1 of 2 is not confirmed yet, so the ones after it were not signed.");
    });

    it("a transaction the node did not accept stops the run there: the next one is not signed against an unknown state", async () => {
      let sends = 0;
      const refusal = new Error("node refused");
      const f = fixture({
        onSend: () => {
          if (sends++ === 1) throw refusal;
        },
      });
      const result = await f.sender.prepareAndSendAll(requests(3), { mode: "per-transaction", onSigned: () => {} });
      expect(f.sign).toHaveBeenCalledTimes(2);
      expect(result.outcomes.map((o) => o.sent)).toEqual([true, false, false]);
      // The journalled one keeps its signature (it may still land); the next was never signed.
      expect(result.outcomes[1]).toMatchObject({ error: refusal });
      expect(result.outcomes[1].signature).not.toBeNull();
      expect(result.outcomes[2]).toMatchObject({ signature: null, error: refusal });
    });

    it("a status read the RPC refused for a moment (HTTP 429) is read again: one refused read no longer stops the run", async () => {
      let reads = 0;
      const f = fixture({
        status: () => {
          if (reads++ === 0) throw new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: "HTTP", statusCode: 429 });
          return { err: null, confirmationStatus: "confirmed" };
        },
      });
      const result = await f.sender.prepareAndSendAll(requests(2), { mode: "per-transaction", onSigned: () => {} });
      expect(result.outcomes.map((o) => o.sent)).toEqual([true, true]);
      expect(result.outcomes.every((o) => o.error === null)).toBe(true);
      expect(f.sign).toHaveBeenCalledTimes(2);
      // The refused read and its retry, both for transaction 1.
      expect(f.statusCalls).toHaveLength(2);
      expect(new Set(f.statusCalls.flat()).size).toBe(1);
    });

    it("says when it waits for the network between two prompts (not after the last one)", async () => {
      const f = fixture();
      const order: string[] = [];
      await f.sender.prepareAndSendAll(requests(3), {
        mode: "per-transaction",
        onSigned: () => {},
        onPrompt: (p) => order.push(`prompt:${p.index}`),
        onWaiting: (w) => order.push(`waiting:${w.index}/${w.count}`),
      });
      expect(order).toEqual(["prompt:0", "waiting:0/3", "prompt:1", "waiting:1/3", "prompt:2"]);
    });
  });

  // The panel's onSigned hook (components/send-to-wallets-panel, built by journalThenPendingAudits): the
  // journal, then each transaction's pending audit row (lib/distribution-audit-writer), both before the broadcast.
  describe("the pending audit row of each transaction, written when it is journalled (before its broadcast)", () => {
    function auditTrail(record?: (row: DistributionAuditRow) => Promise<string | null>) {
      const rows: DistributionAuditRow[] = [];
      const audits = createPendingAuditWriter({
        record:
          record ??
          (async (row) => {
            events.push(`audit:${row.status}`);
            rows.push(row);
            return `id-${rows.length}`;
          }),
        base: () => ({ actor: WALLET, reason: "Distribution run test: 3 wallets", scPda: PROGRAM, runId: "run-1", mint: PROGRAM, screening: null }),
      });
      const journal: BatchSigned[] = [];
      const waits: number[] = [];
      const hook = journalThenPendingAudits({
        journal: (signed: readonly BatchSigned[]) => {
          journal.push(...signed);
          events.push("journal");
        },
        audits,
        rowsOf: (index) => [{ wallet: String(WALLET), amount: BigInt(index + 1) }],
      });
      const onSigned = (signed: readonly BatchSigned[], info: BatchSignedInfo) => {
        waits.push(info.waitMs);
        return hook(signed, info);
      };
      return { rows, journal, onSigned, waits, audits };
    }
    const trail = () => events.filter((e) => ["wallet.single", "wallet.batch(3)", "journal", "audit:pending", "send", "settle"].includes(e));

    it("one by one, interrupted after transaction 1 of 3 (the tab closed at the second prompt): transaction 1 still has its pending row", async () => {
      const f = fixture();
      const { rows, journal, onSigned } = auditTrail();
      const sign = f.sign.getMockImplementation()!;
      let prompts = 0;
      f.sign.mockImplementation(async (prepared: TransactionPrepared) => {
        // The second prompt is never answered: the tab is closed while the wallet asks.
        if (++prompts === 2) {
          events.push("wallet.single");
          return new Promise<never>(() => {});
        }
        return sign(prepared);
      });
      void f.sender.prepareAndSendAll(requests(3), { mode: "per-transaction", onSigned });
      await vi.waitFor(() => expect(prompts).toBe(2));
      expect(journal).toHaveLength(1);
      expect(f.sent).toHaveLength(1);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        ix_name: "share_class_distribution",
        status: "pending",
        tx_signature: journal[0].signature,
        metadata: { run_id: "run-1", recipients: [{ to: String(WALLET), amount: "1", screening: null }] },
      });
      // Journalled, its pending row written, then broadcast and waited for; only then the second prompt.
      expect(trail()).toEqual(["wallet.single", "journal", "audit:pending", "send", "settle", "wallet.single"]);
    });

    it("a batch: every transaction's pending row before the first of them is broadcast", async () => {
      const f = fixture();
      const { rows, journal, onSigned } = auditTrail();
      await f.sender.prepareAndSendAll(requests(3), { onSigned });
      expect(rows.map((r) => r.tx_signature)).toEqual(journal.map((s) => s.signature));
      expect(trail()).toEqual(["wallet.batch(3)", "journal", "audit:pending", "audit:pending", "audit:pending", "send", "send", "send"]);
    });

    it("the hook is told how long the blockhash can spare above the broadcast margin: a batch from the block height, one by one from the time", async () => {
      // The batch's blockhash is valid up to 1001, the height after signing 900: 71 blocks above the 30-block margin.
      const batch = auditTrail();
      await fixture().sender.prepareAndSendAll(requests(3), { onSigned: batch.onSigned });
      expect(batch.waits).toEqual([Number(BigInt(1001) - BigInt(900) - BATCH_EXPIRY_MARGIN_BLOCKS) * MS_PER_BLOCK]);
      // One by one: no height read; the blockhash's ~150 blocks less the margin, less the time signing took.
      const single = auditTrail();
      await fixture().sender.prepareAndSendAll(requests(2), { mode: "per-transaction", onSigned: single.onSigned });
      const most = (BLOCKHASH_LIFETIME_BLOCKS - Number(BATCH_EXPIRY_MARGIN_BLOCKS)) * MS_PER_BLOCK;
      expect(single.waits).toHaveLength(2);
      for (const w of single.waits) {
        expect(w).toBeLessThanOrEqual(most);
        expect(w).toBeGreaterThan(most - 5_000);
      }
    });

    it("a slow audit route never eats into the margin: with one block to spare the batch is broadcast at once, its rows finished after (settle)", async () => {
      // 970 + 30 = 1000: one block (MS_PER_BLOCK) above the margin of the blockhash valid up to 1001.
      const f = fixture({ heightAfterSigning: 970 });
      let open: () => void = () => {};
      const gate = new Promise<void>((resolve) => (open = resolve));
      const written: string[] = [];
      const { journal, onSigned, waits, audits } = auditTrail(async (row) => {
        await gate;
        written.push(row.tx_signature);
        return "id";
      });
      const started = Date.now();
      const result = await f.sender.prepareAndSendAll(requests(3), { onSigned });
      expect(waits).toEqual([MS_PER_BLOCK]);
      // Not PENDING_AUDIT_WAIT_MS (5 s): the hook's wait was capped at the one block the blockhash could spare.
      expect(Date.now() - started).toBeLessThan(PENDING_AUDIT_WAIT_MS - 1_000);
      expect(result.outcomes.every((o) => o.sent)).toBe(true);
      expect(f.sent).toHaveLength(3);
      expect(written).toEqual([]);
      open();
      expect(await audits.settle(journal.map((s) => s.signature))).toEqual(new Set(journal.map((s) => s.signature)));
      expect(written).toEqual(journal.map((s) => s.signature));
    });

    it("a wallet change while the hook ran: nothing more is broadcast (a batch throws; one by one, the ones before it stay sent)", async () => {
      const disconnect = (f: ReturnType<typeof fixture>) => {
        (f.client as unknown as { store: { getState: () => unknown } }).store.getState = () => ({ wallet: { status: "disconnected" } });
      };
      const batch = fixture();
      const error = await batch.sender.prepareAndSendAll(requests(2), { onSigned: () => disconnect(batch) }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TransactionWalletChangedError);
      expect(batch.sent).toHaveLength(0);

      const single = fixture();
      const result = await single.sender.prepareAndSendAll(requests(3), {
        mode: "per-transaction",
        onSigned: (signed) => {
          if (signed[0].index === 1) disconnect(single);
        },
      });
      expect(result.outcomes.map((o) => o.sent)).toEqual([true, false, false]);
      expect(result.outcomes[1].error).toBeInstanceOf(TransactionWalletChangedError);
      expect(result.outcomes[1].signature).not.toBeNull();
      expect(single.sent).toHaveLength(1);
    });
  });

  describe("between two calls (a distribution's groups): every transaction of the previous one, and its outcome", () => {
    it("waits for every transaction the previous batch sent, in one status read, before anything of the next call", async () => {
      const f = fixture();
      const first = await f.sender.prepareAndSendAll(requests(3), { onSigned: () => {} });
      events.length = 0;
      await f.sender.prepareAndSendAll(requests(2), { onSigned: () => {} });
      expect(f.statusCalls).toEqual([first.outcomes.map((o) => o.signature)]);
      expect(events.indexOf("settle")).toBeLessThan(events.indexOf("simulate"));
    });

    it("a previous transaction that failed, or whose status cannot be read, stops the next call before any simulation or prompt", async () => {
      for (const status of [
        () => ({ err: { InstructionError: [4, { Custom: 6001 }] }, confirmationStatus: "confirmed" }),
        () => {
          throw new Error("RPC unavailable");
        },
      ]) {
        let previous: string[] = [];
        const f = fixture({ status: (s) => (previous.includes(s) ? status() : { err: null, confirmationStatus: "confirmed" }) });
        const first = await f.sender.prepareAndSendAll(requests(2), { onSigned: () => {} });
        previous = first.outcomes.map((o) => o.signature!);
        events.length = 0;
        const onSigned = vi.fn();
        const error = await f.sender.prepareAndSendAll(requests(2), { mode: "per-transaction", onSigned }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(EarlierTransactionUnconfirmedError);
        expect(error).toMatchObject({ position: null });
        // What happened only: the caller (Send to wallets) adds how to go on.
        expect((error as Error).message).toMatch(/^A transaction sent just before these (failed on the network|is not confirmed yet).*so these were not signed\.$/);
        expect(events).not.toContain("simulate");
        expect(events).not.toContain("wallet.single");
        expect(onSigned).not.toHaveBeenCalled();
      }
    });

    it("the per-transaction path's last transaction is the one the next call waits for (the earlier ones were confirmed in turn)", async () => {
      const f = fixture();
      const first = await f.sender.prepareAndSendAll(requests(3), { mode: "per-transaction", onSigned: () => {} });
      f.statusCalls.length = 0;
      await f.sender.prepareAndSendAll(requests(1), { mode: "per-transaction", onSigned: () => {} });
      expect(f.statusCalls[0]).toEqual([first.outcomes[2].signature]);
    });

    it("onSettlingPrevious: told how many are waited for, before that wait (the page says so); not called when there is none", async () => {
      const f = fixture();
      const onSettlingPrevious = vi.fn(() => void events.push("settling"));
      await f.sender.prepareAndSendAll(requests(3), { onSigned: () => {}, onSettlingPrevious });
      expect(onSettlingPrevious).not.toHaveBeenCalled();
      events.length = 0;
      await f.sender.prepareAndSendAll(requests(2), { onSigned: () => {}, onSettlingPrevious });
      expect(onSettlingPrevious).toHaveBeenCalledExactlyOnceWith({ count: 3 });
      expect(events.indexOf("settling")).toBeLessThan(events.indexOf("settle"));
    });

    it("a wallet change ends that wait at the next read, not after SETTLE_TIMEOUT_MS", async () => {
      let previous: string[] = [];
      // The previous send is never confirmed.
      const f = fixture({ status: (s) => (previous.includes(s) ? null : { err: null, confirmationStatus: "confirmed" }) });
      const first = await f.sender.prepareAndSendAll(requests(2), { onSigned: () => {} });
      previous = first.outcomes.map((o) => o.signature!);
      const started = Date.now();
      const error = await f.sender
        .prepareAndSendAll(requests(1), {
          onSigned: () => {},
          onSettlingPrevious: () => {
            (f.client as unknown as { store: { getState: () => unknown } }).store.getState = () => ({ wallet: { status: "disconnected" } });
          },
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TransactionWalletChangedError);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(f.statusCalls).toHaveLength(1);
    });
  });

  describe("onFallback: the batch was given up before the first one-by-one prompt", () => {
    it("is called with the reason before that prompt", async () => {
      const f = fixture();
      wallet.mode = "fewer";
      const order: string[] = [];
      const result = await f.sender.prepareAndSendAll(requests(2), {
        onSigned: () => {},
        onPrompt: (p) => order.push(`prompt:${p.mode}:${p.index}`),
        onFallback: (reason) => order.push(`fallback:${reason}`),
      });
      expect(order).toEqual(["prompt:batch:0", `fallback:${result.fallbackReason}`, "prompt:per-transaction:0", "prompt:per-transaction:1"]);
    });

    it("is not called when the batch is signed, or with 'per-transaction' from the start", async () => {
      const onFallback = vi.fn();
      await fixture().sender.prepareAndSendAll(requests(2), { onSigned: () => {}, onFallback });
      await fixture().sender.prepareAndSendAll(requests(2), { mode: "per-transaction", onSigned: () => {}, onFallback });
      expect(onFallback).not.toHaveBeenCalled();
    });
  });

  it("a refusal's advice follows what it is about: a guard is not a fee setting, and another wallet means the same account", () => {
    const guards = new SignedTransactionChangedError("the wallet added a Lighthouse instruction Manci does not accept (Lighthouse.#16)", "guards").message;
    expect(guards).toMatch(/^The wallet added a Lighthouse instruction Manci does not accept \(Lighthouse\.#16\), so it was not sent\./);
    expect(guards).toMatch(/safety checks \(Lighthouse assertions, as Phantom adds\) only when it can verify them and they fit/);
    expect(guards).toMatch(/another wallet app that holds this same account, or send the remaining recipients one at a time with “Send to holder”/);
    expect(guards).not.toMatch(/priority fee/);
    expect(new SignedTransactionChangedError("x", "compute-budget").message).toMatch(/Turn off the wallet's custom priority fee or use another wallet app that holds this same account/);
    expect(new SignedTransactionChangedError("x").message).toMatch(/Use another wallet app that holds this same account and open this page again/);
  });

  it("remembers 'sign separately' for the wallet only for a fallback that every batch would repeat", () => {
    expect(remembersSignSeparately(`One-prompt signing is not available: ${SIGNING_TOO_SLOW}`)).toBe(true);
    expect(remembersSignSeparately(`One-prompt signing is not available: ${WALLET_STATE_GUARDS}`)).toBe(true);
    expect(remembersSignSeparately("One-prompt signing is not available: the wallet returned 1 of 3 transactions")).toBe(false);
    expect(remembersSignSeparately(null)).toBe(false);
    // The panel remembers it for the wallet, and says once how to continue.
    const panel = readFileSync(join(process.cwd(), "components/send-to-wallets-panel.tsx"), "utf8");
    // As soon as the batch falls back (onFallback), so a first one-by-one prompt that throws does not lose it.
    expect(panel).toMatch(/onFallback: \(reason\) => \{\s*if \(remembersSignSeparately\(reason\)\) chooseSeparate\(true\);\s*\}/);
    expect(panel).not.toContain("remembersSignSeparately(result.fallbackReason)");
    expect(panel).toContain('${why}${/open this page again/i.test(why) ? "" : " Open this page again to continue the run."}');
    // A transfer that landed and failed is not "not confirmed yet": nothing of it moved, and the resume sends its rows.
    expect(panel).toContain('if (outcomes.some((o) => o === "failed")) {');
    expect(panel).toContain("Some transfers failed on the network: nothing of them moved");
  });

  it("exists only on the app's verified client", () => {
    const f = fixture();
    expect(getBatchSender(f.guarded)).not.toBeNull();
    expect(getBatchSender(f.client)).toBeNull();
  });
});

// What a wallet may change in a distribution's transactions, and nothing
// else: Lighthouse assertions added before and/or after the app's
// instructions (Phantom on mainnet, Manci's compute budget kept), and its own
// compute budget within bounds — the price up to the network's cap (devnet
// here: 100 000 micro-lamports), the limit no lower than the simulation
// consumed (120 000 here). The wallet's signature is the one journalled and
// broadcast.
describe("prepareAndSendAll: what a wallet may change", () => {
  const SYSTEM = address("11111111111111111111111111111111");
  const OTHER = address("GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi");
  const isBudget = (i: Instruction) => i.programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS;

  /** The message rebuilt as a wallet would: the instructions edited, the blockhash kept unless swapped. */
  function rewritten(messageBytes: Uint8Array, edit: (ixs: Instruction[]) => Instruction[], swapBlockhash = false): Uint8Array {
    const compiled = getCompiledTransactionMessageDecoder().decode(messageBytes);
    const message = decompileTransactionMessage(compiled);
    const hash = swapBlockhash ? blockhash("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin") : blockhash(String(compiled.lifetimeToken));
    const next = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(WALLET, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: hash, lastValidBlockHeight: BigInt(0) }, m),
      (m) => appendTransactionMessageInstructions(edit([...message.instructions] as Instruction[]), m),
    );
    return Uint8Array.from(compileTransaction(next).messageBytes);
  }
  /** A wallet that sets its own compute budget: its price and limit, price first, Manci's removed. */
  const ownBudget = (price: bigint, units: number) => (ixs: Instruction[]) => [
    setComputeUnitPriceInstruction(price),
    setComputeUnitLimitInstruction(units),
    ...ixs.filter((i) => !isBudget(i)),
  ];
  /** A per-transaction wallet (base.sign) that rewrites the message with `edit`. */
  const signWith = (edit: (ixs: Instruction[]) => Instruction[], swapBlockhash = false) => async (prepared: TransactionPrepared) => {
    events.push("wallet.single");
    const built = compileTransaction(prepared.message as Parameters<typeof compileTransaction>[0]);
    const messageBytes = rewritten(Uint8Array.from(built.messageBytes), edit, swapBlockhash);
    return { messageBytes, signatures: { [WALLET]: new Uint8Array(64).fill(7) } } as never;
  };
  /** What was broadcast: each wire transaction's id and compute budget. */
  const broadcast = (wires: string[]) =>
    wires.map((w) => {
      const tx = getTransactionDecoder().decode(getBase64Encoder().encode(w));
      const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
      const budget = message.instructions
        .filter((i) => message.staticAccounts[i.programAddressIndex] === COMPUTE_BUDGET_PROGRAM_ADDRESS)
        .map((i) => decodeComputeBudgetInstruction({ programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, data: i.data }));
      return { id: transactionId(tx), budget };
    });

  it("batch: a wallet's own compute budget (price ≤ cap, limit ≥ need, reordered) is accepted; the wallet's signatures are journalled and sent", async () => {
    const f = fixture();
    wallet.rewrite = (bytes) => rewritten(bytes, ownBudget(BigInt(80_000), 150_000));
    const journal: BatchSigned[] = [];
    const result = await f.sender.prepareAndSendAll(requests(3), { onSigned: (s) => void journal.push(...s) });
    expect(result).toMatchObject({ mode: "batch", prompts: 1, fallbackReason: null });
    expect(f.sign).not.toHaveBeenCalled();
    const sent = broadcast(f.sent);
    expect(sent).toHaveLength(3);
    // The wallet's own compute budget went out, and the journal holds exactly those signatures.
    for (const s of sent) expect(s.budget).toEqual([{ kind: "price", microLamports: BigInt(80_000) }, { kind: "limit", units: 150_000 }]);
    expect(journal.map((j) => j.signature)).toEqual(sent.map((s) => s.id));
    expect(result.outcomes.map((o) => o.signature)).toEqual(sent.map((s) => s.id));
    expect(new Set(journal.map((j) => j.lastValidBlockHeight.toString()))).toEqual(new Set(["1001"]));
  });

  it("batch: a price at the cap and a limit at the simulated need are accepted, and so is a wallet that drops the price", async () => {
    const f = fixture();
    wallet.rewrite = (bytes, i) =>
      rewritten(bytes, i === 0 ? ownBudget(BigInt(100_000), 120_000) : (ixs) => [setComputeUnitLimitInstruction(300_000), ...ixs.filter((x) => !isBudget(x))]);
    const result = await f.sender.prepareAndSendAll(requests(2), { onSigned: () => {} });
    expect(result).toMatchObject({ mode: "batch", fallbackReason: null });
    expect(f.sent).toHaveLength(2);
  });

  it("a price above the cap: the batch falls back, and one by one it is refused with a clear reason; nothing journalled or sent", async () => {
    const f = fixture();
    wallet.rewrite = (bytes) => rewritten(bytes, ownBudget(BigInt(100_001), 150_000));
    f.sign.mockImplementation(signWith(ownBudget(BigInt(100_001), 150_000)));
    const onSigned = vi.fn();
    const error = await f.sender.prepareAndSendAll(requests(2), { onSigned }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignedTransactionChangedError);
    expect((error as Error).message).toMatch(
      /raised the priority fee to 100001 micro-lamports per compute unit, above Manci's cap of 100000.*transaction 1 of 2.*not sent/,
    );
    // A wallet setting can fix this one: the advice says so.
    expect((error as Error).message).toMatch(/Turn off the wallet's custom priority fee or use another wallet/);
    expect(onSigned).not.toHaveBeenCalled();
    expect(f.sent).toHaveLength(0);
  });

  it("a limit below what the simulation consumed: the batch falls back, the reason names both", async () => {
    const f = fixture();
    wallet.rewrite = (bytes) => rewritten(bytes, ownBudget(BigInt(50_000), 119_999));
    const result = await f.sender.prepareAndSendAll(requests(2), { onSigned: () => {} });
    expect(result.mode).toBe("per-transaction");
    expect(result.fallbackReason).toMatch(/compute unit limit to 119999, below the 120000/);
  });

  it("per transaction: a wallet's own compute budget is accepted; the journal holds the wallet's signature, which is what was sent", async () => {
    const f = fixture();
    f.sign.mockImplementation(signWith(ownBudget(BigInt(90_000), 140_000)));
    const journal: BatchSigned[] = [];
    const result = await f.sender.prepareAndSendAll(requests(2), { mode: "per-transaction", onSigned: (s) => void journal.push(...s) });
    expect(result.outcomes.map((o) => o.sent)).toEqual([true, true]);
    const sent = broadcast(f.sent);
    expect(sent.map((s) => s.budget[0])).toEqual([
      { kind: "price", microLamports: BigInt(90_000) },
      { kind: "price", microLamports: BigInt(90_000) },
    ]);
    expect(journal.map((j) => j.signature)).toEqual(sent.map((s) => s.id));
    expect(journal.map((j) => j.lastValidBlockHeight.toString())).toEqual(["1001", "1002"]);
  });

  const transfer: Instruction = {
    programAddress: SYSTEM,
    accounts: [
      { address: WALLET, role: AccountRole.WRITABLE_SIGNER },
      { address: OTHER, role: AccountRole.WRITABLE },
    ],
    data: Uint8Array.of(2, 0, 0, 0, 64, 66, 15, 0, 0, 0, 0, 0),
  };
  const fee = ownBudget(BigInt(80_000), 150_000);
  const otherChanges: [string, (ixs: Instruction[]) => Instruction[], boolean, RegExp][] = [
    ["an extra transfer", (ixs) => [...fee(ixs), transfer], false, /changed its instructions/],
    [
      "a different account",
      (ixs) => fee(ixs).map((i) => (isBudget(i) ? i : { ...i, accounts: [{ address: OTHER, role: AccountRole.WRITABLE }] })),
      false,
      /changed the accounts of instruction 3/,
    ],
    ["a different amount", (ixs) => fee(ixs).map((i) => (isBudget(i) ? i : { ...i, data: Uint8Array.of(99) })), false, /changed the data of instruction 3/],
    ["a blockhash swap", fee, true, /replaced its blockhash/],
    [
      "a heap frame request",
      (ixs) => [{ programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, data: Uint8Array.of(1, 0, 0, 1, 0) }, ...fee(ixs)],
      false,
      /compute-budget instruction Manci does not accept \(ComputeBudget\.RequestHeapFrame\)/,
    ],
  ];

  it.each(otherChanges)("any other change is still refused, fee rewrite or not: %s", async (_label, edit, swap, reason) => {
    // The batch falls back on it…
    const f = fixture();
    wallet.rewrite = (bytes) => rewritten(bytes, edit, swap);
    f.sign.mockImplementation(signWith(edit, swap));
    const onSigned = vi.fn();
    const error = await f.sender.prepareAndSendAll(requests(2), { onSigned }).catch((e: unknown) => e);
    // …and one by one it is refused: nothing journalled, nothing sent.
    expect(signTransactionsWithWallet).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(SignedTransactionChangedError);
    expect((error as Error).message).toMatch(reason);
    expect(onSigned).not.toHaveBeenCalled();
    expect(f.sent).toHaveLength(0);
  });

  // Phantom on mainnet (every Manci transaction it signed there): Manci's
  // compute budget kept as built, Lighthouse assertions added before and
  // after the app's instructions, the Lighthouse key read-only.
  const LIGHTHOUSE = address(LIGHTHOUSE_PROGRAM_ADDRESS);
  const assertion = (kind: number, target: Address, role: AccountRole = AccountRole.READONLY): Instruction => ({
    programAddress: LIGHTHOUSE,
    accounts: [{ address: target, role }],
    data: Uint8Array.of(kind, 4, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  });
  const lighthouse = (ixs: Instruction[]) => [
    ...ixs.filter(isBudget),
    assertion(6, WALLET),
    ...ixs.filter((i) => !isBudget(i)),
    assertion(6, WALLET),
    assertion(10, OTHER),
  ];
  /** Two rows per transaction, each naming the fee payer and a writable account (a recipient's token account). */
  const row = (tag: number): Instruction => ({
    programAddress: PROGRAM,
    accounts: [
      { address: WALLET, role: AccountRole.WRITABLE_SIGNER },
      { address: OTHER, role: AccountRole.WRITABLE },
    ],
    data: Uint8Array.of(tag),
  });
  const rowRequests = (count: number) => Array.from({ length: count }, (_, i) => ({ feePayer: WALLET, instructions: [row(2 * i + 1), row(2 * i + 2)] }));
  const programsOf = (wire: string) => {
    const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(getBase64Encoder().encode(wire)).messageBytes);
    return message.instructions.map((i) => String(message.staticAccounts[i.programAddressIndex]).slice(0, 4));
  };

  it("batch: one transaction with Phantom's guards is accepted; its signature is journalled and sent, the compute budget as built", async () => {
    const f = fixture();
    wallet.rewrite = (bytes) => rewritten(bytes, lighthouse);
    const journal: BatchSigned[] = [];
    const result = await f.sender.prepareAndSendAll(rowRequests(1), { onSigned: (s) => void journal.push(...s) });
    expect(result).toMatchObject({ mode: "batch", prompts: 1, fallbackReason: null });
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.sent.map(programsOf)).toEqual([["Comp", "Comp", "L2TE", "FJs1", "FJs1", "L2TE", "L2TE"]]);
    const sent = broadcast(f.sent);
    const built = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(wallet.calls[0][0]).messageBytes);
    const builtBudget = built.instructions
      .filter((i) => built.staticAccounts[i.programAddressIndex] === COMPUTE_BUDGET_PROGRAM_ADDRESS)
      .map((i) => decodeComputeBudgetInstruction({ programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, data: i.data }));
    expect(sent[0].budget).toEqual(builtBudget);
    expect(journal.map((j) => j.signature)).toEqual(sent.map((s) => s.id));
    expect(result.outcomes.map((o) => o.signature)).toEqual(sent.map((s) => s.id));
  });

  it("batch: several transactions, any of them with Phantom's guards, are never journalled or sent together: one prompt each", async () => {
    for (const guarded of [[0, 1, 2], [2]]) {
      // Every copy guarded, or only the last (a full pack has no room for a guard, a partly filled one does).
      const f = fixture();
      events.length = 0;
      wallet.rewrite = (bytes, i) => (guarded.includes(i) ? rewritten(bytes, lighthouse) : bytes);
      f.sign.mockImplementation(signWith(lighthouse));
      const journal: BatchSigned[][] = [];
      const result = await f.sender.prepareAndSendAll(rowRequests(3), { onSigned: (s) => void journal.push([...s]) });
      expect(result).toMatchObject({ mode: "per-transaction", prompts: 3 });
      expect(result.fallbackReason).toContain(WALLET_STATE_GUARDS);
      expect(signTransactionsWithWallet).toHaveBeenCalledTimes(1);
      vi.mocked(signTransactionsWithWallet).mockClear();
      // Nothing of the batch: only the one-by-one signatures, each journalled before its own broadcast.
      expect(journal.map((j) => j.map((s) => s.index))).toEqual([[0], [1], [2]]);
      expect(journal.flat().map((s) => s.signature)).toEqual(broadcast(f.sent).map((s) => s.id));
      expect(events.filter((e) => e === "wallet.single" || e === "send" || e === "settle").slice(0, 4)).toEqual(["wallet.single", "send", "settle", "wallet.single"]);
    }
  });

  describe("Send to wallets' headroom for guards (computeUnitHeadroom)", () => {
    /** The limit the wallet was asked to sign under (the first instruction: Manci's SetComputeUnitLimit). */
    const builtLimit = (bytes: Uint8Array) => {
      const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(bytes).messageBytes);
      return decodeComputeBudgetInstruction({ programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, data: message.instructions[0].data });
    };

    it("builds max(200,000, ceil(1.1 × need) + headroom); without it, the SDK's formula", async () => {
      sim.units = 500_000;
      await fixture().sender.prepareAndSendAll(requests(1), { onSigned: () => {}, computeUnitHeadroom: DISTRIBUTION_GUARD_HEADROOM_UNITS });
      expect(builtLimit(wallet.calls[0][0])).toEqual({ kind: "limit", units: 578_000 });
      await fixture().sender.prepareAndSendAll(requests(1), { onSigned: () => {} });
      expect(builtLimit(wallet.calls[1][0])).toEqual({ kind: "limit", units: 550_000 });
      // A small transaction: the 200,000 floor already leaves the room (no extra fee).
      sim.units = 120_000;
      await fixture().sender.prepareAndSendAll(requests(1), { onSigned: () => {}, computeUnitHeadroom: DISTRIBUTION_GUARD_HEADROOM_UNITS });
      expect(builtLimit(wallet.calls[2][0])).toEqual({ kind: "limit", units: 200_000 });
    });

    it("four guards on a 250,000-unit transaction: refused without the headroom (275,000 < 278,000), accepted with it", async () => {
      sim.units = 250_000;
      const fourGuards = (ixs: Instruction[]) => [...lighthouse(ixs), assertion(10, OTHER)];
      const without = fixture();
      wallet.rewrite = (bytes) => rewritten(bytes, fourGuards);
      without.sign.mockImplementation(signWith(fourGuards));
      const refused = await without.sender.prepareAndSendAll(rowRequests(1), { onSigned: () => {} }).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(SignedTransactionChangedError);
      expect((refused as Error).message).toMatch(/added 4 Lighthouse instructions .*compute unit limit of 275000 is below the 278000 the transaction needs with them/);
      expect(without.sent).toHaveLength(0);

      const withRoom = fixture();
      const result = await withRoom.sender.prepareAndSendAll(rowRequests(1), { onSigned: () => {}, computeUnitHeadroom: DISTRIBUTION_GUARD_HEADROOM_UNITS });
      expect(result).toMatchObject({ mode: "batch", prompts: 1, fallbackReason: null });
      expect(broadcast(withRoom.sent)[0].budget[0]).toEqual({ kind: "limit", units: 303_000 });
    });

    it("refuses a headroom that is not a whole number of units within the 1.4M ceiling, before anything else", async () => {
      for (const computeUnitHeadroom of [-1, 1.5, 1_400_001, Number.NaN]) {
        const f = fixture();
        await expect(f.sender.prepareAndSendAll(requests(1), { onSigned: () => {}, computeUnitHeadroom })).rejects.toThrow(/headroom must be an integer/);
      }
      expect(events).not.toContain("simulate");
    });

    it("the panel asks for it on every group of a distribution", () => {
      const panel = readFileSync(join(process.cwd(), "components/send-to-wallets-panel.tsx"), "utf8");
      expect(panel).toMatch(/sender\.prepareAndSendAll\(requests, \{[\s\S]{0,400}computeUnitHeadroom: DISTRIBUTION_GUARD_HEADROOM_UNITS,/);
    });
  });

  it("guards on several: the fallback is reported (onFallback) before the first one-by-one prompt, so a refusal there still leaves it remembered", async () => {
    const f = fixture();
    wallet.rewrite = (bytes) => rewritten(bytes, lighthouse);
    f.sign.mockRejectedValueOnce(Object.assign(new Error("User rejected the request."), { code: 4001 }));
    const reasons: string[] = [];
    await expect(
      f.sender.prepareAndSendAll(rowRequests(2), { onSigned: () => {}, onFallback: (reason) => void reasons.push(reason) }),
    ).rejects.toMatchObject({ code: 4001 });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain(WALLET_STATE_GUARDS);
    expect(remembersSignSeparately(reasons[0])).toBe(true);
    expect(f.sent).toHaveLength(0);
  });

  // Phantom's guard on the fee payer, decoded from the mainnet transactions it
  // signed: AssertAccountInfoMulti Lamports >= floor, where floor = the
  // balance its simulation saw - the fee - 1.1 × the rent the transaction
  // pays - 0.005 SOL (tests/wallet-changes pins it on the fixtures). A
  // transaction that creates 8 token accounts spends 12 338 920 lamports;
  // another one's floor leaves it 6 231 392. Here the network lands each
  // broadcast transaction, in order, when it is next asked about one.
  describe("Phantom's balance guards against the network", () => {
    const FEE = BigInt(25_000);
    const RENT = BigInt(1_539_240) * BigInt(8);
    const SLACK = BigInt(5_000_000);
    const floorFor = (seen: bigint) => seen - FEE - RENT - RENT / BigInt(10) - SLACK;
    const payerGuard = (floor: bigint): Instruction => {
      const data = new Uint8Array(13);
      data.set([6, 4, 1, 0]);
      new DataView(data.buffer).setBigUint64(4, floor, true);
      data[12] = 4;
      return { programAddress: LIGHTHOUSE, accounts: [{ address: WALLET, role: AccountRole.READONLY }], data };
    };
    const floorOf = (tx: Transaction): bigint | null => {
      const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
      const guard = message.instructions.find((i) => message.staticAccounts[i.programAddressIndex] === LIGHTHOUSE && i.data?.[0] === 6);
      return guard?.data ? new DataView(Uint8Array.from(guard.data).buffer).getBigUint64(4, true) : null;
    };

    function network(start: bigint) {
      let balance = start;
      const queue: Transaction[] = [];
      const landed = new Map<string, "confirmed" | "failed">();
      const land = () => {
        for (const tx of queue.splice(0)) {
          const post = balance - FEE - RENT;
          const floor = floorOf(tx);
          // A guard that no longer holds: the transaction fails, paying its fee only.
          if (floor !== null && post < floor) {
            balance -= FEE;
            landed.set(transactionId(tx), "failed");
          } else {
            balance = post;
            landed.set(transactionId(tx), "confirmed");
          }
        }
      };
      return {
        /** What the wallet's simulation sees: every landed transaction. */
        seen: () => balance,
        send: (wire: string) => void queue.push(getTransactionDecoder().decode(getBase64Encoder().encode(wire))),
        status: (signature: string): SignatureStatus => {
          land();
          const outcome = landed.get(signature);
          return outcome ? { err: outcome === "failed" ? { InstructionError: [4, { Custom: 6001 }] } : null, confirmationStatus: "confirmed" } : null;
        },
        /** Everything sent, landed. */
        outcomes: () => {
          land();
          return [...landed.values()];
        },
      };
    }

    function phantom() {
      const chain = network(BigInt(2_121_150_057));
      const f = fixture({ onSend: chain.send, status: chain.status });
      const guarded = (bytes: Uint8Array) => rewritten(bytes, (ixs) => [...ixs, payerGuard(floorFor(chain.seen()))]);
      wallet.rewrite = guarded;
      let next = 100;
      f.sign.mockImplementation(async (prepared: TransactionPrepared) => {
        events.push("wallet.single");
        const built = compileTransaction(prepared.message as Parameters<typeof compileTransaction>[0]);
        return { messageBytes: guarded(Uint8Array.from(built.messageBytes)), signatures: { [WALLET]: new Uint8Array(64).fill(next++) } } as never;
      });
      return { chain, f };
    }

    it("the model: two transactions guarded against the same balance, landed together, fail all but the first", () => {
      const chain = network(BigInt(2_121_150_057));
      const floor = floorFor(chain.seen());
      for (const fill of [1, 2]) {
        const message = pipe(
          createTransactionMessage({ version: 0 }),
          (m) => setTransactionMessageFeePayer(WALLET, m),
          (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash("4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"), lastValidBlockHeight: BigInt(1) }, m),
          (m) => appendTransactionMessageInstructions([row(fill), payerGuard(floor)], m),
        );
        const tx = { ...compileTransaction(message), signatures: { [WALLET]: new Uint8Array(64).fill(fill) } } as unknown as Transaction;
        chain.send(getBase64EncodedWireTransaction(tx));
      }
      expect(chain.outcomes()).toEqual(["confirmed", "failed"]);
    });

    it("a batch of three: falls back to one prompt each, each signed after the previous landed; all three confirm", async () => {
      const { chain, f } = phantom();
      const result = await f.sender.prepareAndSendAll(rowRequests(3), { onSigned: () => {} });
      expect(result).toMatchObject({ mode: "per-transaction", prompts: 3 });
      expect(result.fallbackReason).toContain(WALLET_STATE_GUARDS);
      expect(result.outcomes.map((o) => o.sent)).toEqual([true, true, true]);
      expect(chain.outcomes()).toEqual(["confirmed", "confirmed", "confirmed"]);
    });

    it("one prompt per transaction from the start: all three confirm", async () => {
      const { chain, f } = phantom();
      const result = await f.sender.prepareAndSendAll(rowRequests(3), { mode: "per-transaction", onSigned: () => {} });
      expect(result.outcomes.map((o) => o.sent)).toEqual([true, true, true]);
      expect(chain.outcomes()).toEqual(["confirmed", "confirmed", "confirmed"]);
    });
  });

  it("per transaction (after a batch the wallet could not sign together): the guards are accepted, the wallet's signature journalled and sent", async () => {
    const f = fixture();
    wallet.mode = "fewer";
    f.sign.mockImplementation(signWith(lighthouse));
    const journal: BatchSigned[] = [];
    const result = await f.sender.prepareAndSendAll(rowRequests(2), { onSigned: (s) => void journal.push(...s) });
    expect(result).toMatchObject({ mode: "per-transaction", prompts: 2 });
    expect(result.outcomes.map((o) => o.sent)).toEqual([true, true]);
    expect(f.sent.map(programsOf)).toEqual(Array(2).fill(["Comp", "Comp", "L2TE", "FJs1", "FJs1", "L2TE", "L2TE"]));
    expect(journal.map((j) => j.signature)).toEqual(broadcast(f.sent).map((s) => s.id));
  });

  it("a guard that names a new writable account: the batch falls back, one by one it is refused and nothing is journalled or sent", async () => {
    const f = fixture();
    const NEW = address("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
    const edit = (ixs: Instruction[]) => [...lighthouse(ixs), assertion(6, NEW, AccountRole.WRITABLE)];
    wallet.rewrite = (bytes) => rewritten(bytes, edit);
    f.sign.mockImplementation(signWith(edit));
    const onSigned = vi.fn();
    const error = await f.sender.prepareAndSendAll(rowRequests(2), { onSigned }).catch((e: unknown) => e);
    expect(signTransactionsWithWallet).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(SignedTransactionChangedError);
    const message = (error as Error).message;
    expect(message).toMatch(/added a Lighthouse instruction \(Lighthouse\.AssertAccountInfoMulti\) that names 9xQe…VFin as writable.*transaction 1 of 2.*not sent/);
    // Not a wallet setting: the advice is another wallet app with the same account or "Send to holder", never a fee setting.
    expect(message).toMatch(/safety checks.*another wallet app that holds this same account.*“Send to holder”/);
    expect(message).not.toMatch(/priority fee/);
    expect(onSigned).not.toHaveBeenCalled();
    expect(f.sent).toHaveLength(0);
  });

  it("a signed copy over the network's 1232-byte packet is refused before anything is journalled", () => {
    const built = compileTransaction(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(WALLET, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash("4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"), lastValidBlockHeight: BigInt(1) }, m),
        (m) => appendTransactionMessageInstructions([setComputeUnitLimitInstruction(1_400_000), row(1), row(2)], m),
      ),
    );
    const sign = (guards: number) => {
      const messageBytes = rewritten(Uint8Array.from(built.messageBytes), (ixs) => [...ixs, ...Array.from({ length: guards }, () => assertion(6, WALLET))]);
      return Uint8Array.from(getTransactionEncoder().encode({ messageBytes, signatures: { [WALLET]: new Uint8Array(64).fill(1) } } as unknown as Transaction));
    };
    const bounds = [{ maxComputeUnitPrice: BigInt(100_000), minComputeUnitLimit: 1_000 }];
    expect(sign(55).length).toBeLessThanOrEqual(1232);
    expect(verifySignedBatch([built], [sign(55)], bounds)).toHaveLength(1);
    expect(sign(56).length).toBe(1236);
    expect(() => verifySignedBatch([built], [sign(56)], bounds)).toThrow(BatchSigningUnsupportedError);
    expect(() => verifySignedBatch([built], [sign(56)], bounds)).toThrow(/transaction 1 came back at 1236 bytes, over the network's 1232-byte packet limit with the 56 Lighthouse instructions the wallet added/);
  });
});
