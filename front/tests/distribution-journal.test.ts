// "Send to wallets" journal and resume (lib/distribution-journal,
// lib/distribution-run): the run id, the journal written before broadcast,
// and the decisions on reopen — confirmed rows are never sent again, pending
// ones are waited for, failed or expired ones go back on the list — with the
// treasury's own transfers as the backstop.
import { describe, expect, it } from "vitest";
import { getBase58Decoder, type Address } from "@solana/kit";
import {
  JOURNAL_PREFIX,
  assertJournalWritable,
  auditsDue,
  countStates,
  dismissJournal,
  distributionRunId,
  journalKey,
  listJournals,
  newJournal,
  parseJournal,
  priorReceipts,
  readJournal,
  rowStates,
  shortRunId,
  transfersFromTransaction,
  txOutcome,
  unfinishedJournals,
  withAudited,
  withOutcomes,
  withTx,
  writeJournal,
  type JournalStore,
  type RawTransaction,
} from "@/lib/distribution-journal";
import { evaluateRun, distributionAuditRow } from "@/lib/distribution-run";
import { recentTreasuryTransfers } from "@/lib/distribution-chain";

const MINT = "HRcahPjAhX9ssiY5WvNJxHmy5vuDL7Q6GF6J5gNGjgwC";
const SENDER = "6AnFbinF7X12mACTVEGfjWZyzYGAShEscAB5UgV3vHsP";
const A = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const B2 = "5MofiJNCoCRkNg1f2Yd7368WkjiNxkZZmUTaQo7xLhku";
const C = "FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SOURCE = "Src1111111111111111111111111111111111111111";
const n = (v: number) => BigInt(v);
const SIG = (c: string) => c.repeat(88);

function memoryStore(): JournalStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const rows = [
  { wallet: A, amount: n(100) },
  { wallet: B2, amount: n(50) },
  { wallet: C, amount: n(7) },
];

describe("run id", () => {
  it("is the same for the same list in any order, and differs by mint, sender, amounts, network and nonce", async () => {
    const base = { network: "devnet", mint: MINT, sender: SENDER, rows };
    const id = await distributionRunId(base);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(await distributionRunId({ ...base, rows: [...rows].reverse() })).toBe(id);
    expect(await distributionRunId({ ...base, rows: [rows[0], rows[1], { wallet: C, amount: n(8) }] })).not.toBe(id);
    expect(await distributionRunId({ ...base, network: "mainnet" })).not.toBe(id);
    expect(await distributionRunId({ ...base, sender: A })).not.toBe(id);
    // "Start as a new run": the same list sent again on purpose.
    expect(await distributionRunId({ ...base, nonce: "2026-10-03T10:00:00Z" })).not.toBe(id);
    expect(shortRunId(id)).toBe(id.slice(0, 8));
  });
});

describe("journal storage", () => {
  it("round-trips, lists this mint and sender only, and refuses malformed rows", () => {
    const store = memoryStore();
    const j = newJournal({ runId: "r1", network: "devnet", mint: MINT, sender: SENDER, rows, now: new Date("2026-10-03T10:00:00Z") });
    writeJournal(store, j);
    expect(readJournal(store, "devnet", "r1")).toEqual(j);
    expect(readJournal(store, "mainnet", "r1")).toBeNull();
    writeJournal(store, { ...newJournal({ runId: "r2", network: "devnet", mint: MINT, sender: A, rows }), createdAt: "2026-10-03T11:00:00Z" });
    writeJournal(store, { ...newJournal({ runId: "r3", network: "devnet", mint: MINT, sender: SENDER, rows }), createdAt: "2026-10-03T12:00:00Z" });
    expect(listJournals(store, { network: "devnet", mint: MINT, sender: SENDER }).map((x) => x.runId)).toEqual(["r3", "r1"]);
    expect(journalKey("devnet", "r1")).toBe(`${JOURNAL_PREFIX}devnet:r1`);
    expect(parseJournal("{")).toBeNull();
    expect(parseJournal(JSON.stringify({ ...j, rows: [{ wallet: A, amount: "1.5" }] }))).toBeNull();
    expect(parseJournal(JSON.stringify({ ...j, txs: [{ signature: "s", lastValidBlockHeight: "x", rows: [], status: "sent" }] }))).toBeNull();
  });

  it("refuses to start without storage (nothing is signed then)", () => {
    expect(() => assertJournalWritable(null)).toThrow(/does not let the page save its progress/);
    const broken = { ...memoryStore(), setItem: () => { throw new Error("quota"); } };
    expect(() => assertJournalWritable(broken)).toThrow(/Allow site data/);
    expect(() => assertJournalWritable(memoryStore())).not.toThrow();
  });
});

describe("resume decisions", () => {
  it("confirmed → done, error → failed, unknown past its last valid block height → expired, else pending", () => {
    expect(txOutcome({ err: null, confirmationStatus: "confirmed" }, n(100), n(50))).toBe("confirmed");
    expect(txOutcome({ err: null, confirmationStatus: "finalized" }, n(100), n(500))).toBe("confirmed");
    expect(txOutcome({ err: { InstructionError: [1, { Custom: 6000 }] }, confirmationStatus: "confirmed" }, n(100), n(50))).toBe("failed");
    expect(txOutcome({ err: null, confirmationStatus: "processed" }, n(100), n(500))).toBe("pending");
    expect(txOutcome(null, n(100), n(100))).toBe("pending");
    expect(txOutcome(null, n(100), n(101))).toBe("expired");
  });

  it("rows: a confirmed transfer is never sent again; pending waits; failed and expired go back on the list", () => {
    let j = newJournal({ runId: "r", network: "devnet", mint: MINT, sender: SENDER, rows });
    j = withTx(j, { signature: SIG("1"), lastValidBlockHeight: "100", rows: [A], status: "sent", at: "x" });
    j = withTx(j, { signature: SIG("2"), lastValidBlockHeight: "100", rows: [B2], status: "sent", at: "x" });
    j = withTx(j, { signature: SIG("3"), lastValidBlockHeight: "100", rows: [C], status: "signed", at: "x" });
    const dest = new Map([[A, "dA"], [B2, "dB"], [C, "dC"]]);
    const outcomes = new Map([[SIG("1"), "confirmed" as const], [SIG("2"), "pending" as const], [SIG("3"), "expired" as const]]);
    const states = rowStates(j, outcomes, dest);
    expect(states.get(A)).toEqual({ state: "done", signature: SIG("1"), via: "journal" });
    expect(states.get(B2)).toEqual({ state: "pending", signature: SIG("2") });
    expect(states.get(C)).toEqual({ state: "todo" });
    expect(countStates(states)).toEqual({ done: 1, pending: 1, todo: 1 });
    // A later transaction of the same run that confirmed C wins over the expired one.
    const resent = withTx(j, { signature: SIG("4"), lastValidBlockHeight: "200", rows: [C], status: "sent", at: "y" });
    expect(rowStates(resent, new Map([...outcomes, [SIG("4"), "confirmed" as const]]), dest).get(C)).toMatchObject({ state: "done" });
    // The statuses are written back to the journal.
    expect(withOutcomes(j, outcomes).txs.map((t) => t.status)).toEqual(["confirmed", "sent", "expired"]);
  });

  it("the backstop marks a row done from a confirmed transfer of exactly its amount the journal does not explain", () => {
    const j = newJournal({ runId: "r", network: "devnet", mint: MINT, sender: SENDER, rows });
    const dest = new Map([[A, "dA"], [B2, "dB"], [C, "dC"]]);
    const states = rowStates(j, new Map(), dest, [
      { signature: SIG("9"), destination: "dA", amount: n(100), blockTime: 1 },
      { signature: SIG("8"), destination: "dB", amount: n(49), blockTime: 1 }, // another amount: not this row
    ]);
    expect(states.get(A)).toEqual({ state: "done", signature: SIG("9"), via: "backstop" });
    expect(states.get(B2)).toEqual({ state: "todo" });
  });
});

describe("backstop decoder (getTransaction, json)", () => {
  const data = (amount: number) => {
    const bytes = new Uint8Array(10);
    bytes[0] = 12;
    new DataView(bytes.buffer).setBigUint64(1, BigInt(amount), true);
    return getBase58Decoder().decode(bytes);
  };
  const tx = (over: Partial<RawTransaction> = {}, ix = { programIdIndex: 4, accounts: [1, 2, 3, 0, 5, 6, 7], data: data(100) }): RawTransaction => ({
    blockTime: 1_759_000_000,
    meta: { err: null },
    transaction: { message: { accountKeys: [SENDER, SOURCE, MINT, "dA", TOKEN_2022, "x", "y", "z"], instructions: [ix] } },
    ...over,
  });

  it("reads transfer_checked out of the treasury: destination and amount", () => {
    expect(transfersFromTransaction(tx(), { signature: SIG("1"), source: SOURCE, mint: MINT })).toEqual([
      { signature: SIG("1"), destination: "dA", amount: n(100), blockTime: 1_759_000_000 },
    ]);
  });

  it("ignores failed transactions, other sources, other mints and other instructions", () => {
    const input = { signature: SIG("1"), source: SOURCE, mint: MINT };
    expect(transfersFromTransaction(tx({ meta: { err: { InstructionError: [0, "x"] } } }), input)).toEqual([]);
    expect(transfersFromTransaction(tx(), { ...input, source: A })).toEqual([]);
    expect(transfersFromTransaction(tx(), { ...input, mint: A })).toEqual([]);
    expect(transfersFromTransaction(tx({}, { programIdIndex: 4, accounts: [1, 2, 3, 0], data: getBase58Decoder().decode(Uint8Array.of(3, 1, 0, 0, 0, 0, 0, 0, 0)) }), input)).toEqual([]);
    expect(transfersFromTransaction(tx({}, { programIdIndex: 0, accounts: [1, 2, 3, 0], data: data(5) }), input)).toEqual([]);
  });
});

describe("evaluateRun (reopening a run)", () => {
  function fakeRpc(input: {
    statuses: Record<string, { err: unknown; confirmationStatus: string } | null>;
    height: number;
    history?: { signature: string; blockTime: number; err?: unknown }[];
    txs?: Record<string, RawTransaction>;
  }) {
    const calls = { statuses: 0, history: 0, getTransaction: 0 };
    const rpc = {
      getSignatureStatuses: (sigs: string[], opts: { searchTransactionHistory: boolean }) => ({
        send: async () => {
          calls.statuses += 1;
          expect(opts.searchTransactionHistory).toBe(true);
          return { value: sigs.map((s) => input.statuses[s] ?? null) };
        },
      }),
      getBlockHeight: (opts: { commitment: string }) => ({
        send: async () => {
          expect(opts.commitment).toBe("finalized");
          return BigInt(input.height);
        },
      }),
      getSignaturesForAddress: () => ({
        send: async () => {
          calls.history += 1;
          return (input.history ?? []).map((h) => ({ signature: h.signature, blockTime: BigInt(h.blockTime), err: h.err ?? null }));
        },
      }),
      getTransaction: (sig: string) => ({
        send: async () => {
          calls.getTransaction += 1;
          return input.txs?.[sig] ?? null;
        },
      }),
    };
    return { rpc: rpc as unknown as Parameters<typeof evaluateRun>[0], calls };
  }

  const dest = new Map([[A, "dA"], [B2, "dB"], [C, "dC"]]);
  const base = () => {
    let j = newJournal({ runId: "r", network: "devnet", mint: MINT, sender: SENDER, rows, now: new Date("2026-10-03T10:00:00Z") });
    j = withTx(j, { signature: SIG("1"), lastValidBlockHeight: "1000", rows: [A, B2], status: "sent", at: "x" });
    j = withTx(j, { signature: SIG("2"), lastValidBlockHeight: "1000", rows: [C], status: "signed", at: "x" });
    return j;
  };

  it("confirmed and pending: nothing is offered again, no backstop scan is needed", async () => {
    const { rpc, calls } = fakeRpc({
      statuses: { [SIG("1")]: { err: null, confirmationStatus: "confirmed" }, [SIG("2")]: { err: null, confirmationStatus: "processed" } },
      height: 900,
    });
    const r = await evaluateRun(rpc, base(), { source: SOURCE as Address, destinations: dest });
    expect(countStates(r.states)).toEqual({ done: 2, pending: 1, todo: 0 });
    expect(r.journal.txs.map((t) => t.status)).toEqual(["confirmed", "signed"]);
    expect(r.journal.finishedAt).toBeNull();
    expect(calls.history).toBe(0);
  });

  it("expired after its last valid block height: the row is sent again — unless the backstop finds it landed", async () => {
    const landed: RawTransaction = {
      blockTime: Date.parse("2026-10-03T10:01:00Z") / 1000,
      meta: { err: null },
      transaction: {
        message: {
          accountKeys: [SENDER, SOURCE, MINT, "dC", TOKEN_2022],
          instructions: [{ programIdIndex: 4, accounts: [1, 2, 3, 0], data: (() => {
            const b = new Uint8Array(10);
            b[0] = 12;
            new DataView(b.buffer).setBigUint64(1, BigInt(7), true);
            return getBase58Decoder().decode(b);
          })() }],
        },
      },
    };
    const statuses = { [SIG("1")]: { err: null, confirmationStatus: "finalized" }, [SIG("2")]: null };
    const expired = await evaluateRun(fakeRpc({ statuses, height: 1001 }).rpc, base(), { source: SOURCE as Address, destinations: dest });
    expect(expired.states.get(C)).toEqual({ state: "todo" });
    expect(expired.journal.txs[1].status).toBe("expired");

    const { rpc, calls } = fakeRpc({
      statuses,
      height: 1001,
      history: [{ signature: SIG("5"), blockTime: Date.parse("2026-10-03T10:01:00Z") / 1000 }],
      txs: { [SIG("5")]: landed },
    });
    const backstop = await evaluateRun(rpc, base(), { source: SOURCE as Address, destinations: dest, now: new Date("2026-10-03T10:05:00Z") });
    expect(backstop.states.get(C)).toEqual({ state: "done", signature: SIG("5"), via: "backstop" });
    expect(backstop.journal.finishedAt).toBe("2026-10-03T10:05:00.000Z");
    // The expired transaction itself is asked for first (not found), then the one backstop transfer decoded.
    expect(calls.getTransaction).toBe(2);
  });

  it("a confirmed transaction stays confirmed when a later lookup finds nothing (pruned or lagging node, a run reopened days later)", async () => {
    const j = withTx(base(), { signature: SIG("1"), lastValidBlockHeight: "1000", rows: [A, B2], status: "confirmed", at: "x" });
    const { rpc, calls } = fakeRpc({ statuses: { [SIG("2")]: { err: null, confirmationStatus: "finalized" } }, height: 5_000 });
    const r = await evaluateRun(rpc, j, { source: SOURCE as Address, destinations: dest });
    expect(r.states.get(A)).toEqual({ state: "done", signature: SIG("1"), via: "journal" });
    expect(r.states.get(B2)).toMatchObject({ state: "done" });
    expect(r.journal.txs.find((t) => t.signature === SIG("1"))?.status).toBe("confirmed");
    expect(calls.getTransaction).toBe(0);
    // The pure pieces agree: the stored status wins over a fresh "expired".
    const expired = new Map([[SIG("1"), "expired" as const]]);
    expect(rowStates(j, expired, dest).get(A)).toMatchObject({ state: "done" });
    expect(withOutcomes(j, expired).txs.find((t) => t.signature === SIG("1"))?.status).toBe("confirmed");
  });

  it("no status past the expiry height, but the node has the transaction: confirmed (or failed), never sent again", async () => {
    const statuses = { [SIG("1")]: { err: null, confirmationStatus: "finalized" }, [SIG("2")]: null };
    const ok: RawTransaction = { blockTime: 1, meta: { err: null }, transaction: { message: { accountKeys: [], instructions: [] } } };
    const landed = await evaluateRun(fakeRpc({ statuses, height: 1001, txs: { [SIG("2")]: ok } }).rpc, base(), { source: SOURCE as Address, destinations: dest });
    expect(landed.states.get(C)).toEqual({ state: "done", signature: SIG("2"), via: "journal" });
    expect(landed.journal.txs[1].status).toBe("confirmed");
    const failed = await evaluateRun(
      fakeRpc({ statuses, height: 1001, txs: { [SIG("2")]: { ...ok, meta: { err: { InstructionError: [0, "x"] } } } } }).rpc,
      base(),
      { source: SOURCE as Address, destinations: dest, backstop: false },
    );
    expect(failed.journal.txs[1].status).toBe("failed");
    expect(failed.states.get(C)).toEqual({ state: "todo" });
  });

  it("the backstop counts the run's own signature in the treasury's history as landed (no status, no transaction on this node)", async () => {
    const statuses = { [SIG("1")]: { err: null, confirmationStatus: "finalized" }, [SIG("2")]: null };
    const { rpc, calls } = fakeRpc({
      statuses,
      height: 1001,
      history: [{ signature: SIG("2"), blockTime: Date.parse("2026-10-03T10:01:00Z") / 1000 }],
    });
    const r = await evaluateRun(rpc, base(), { source: SOURCE as Address, destinations: dest });
    expect(r.states.get(C)).toEqual({ state: "done", signature: SIG("2"), via: "journal" });
    expect(r.journal.txs[1].status).toBe("confirmed");
    // Only the lookup of the expired transaction itself: the run's own signature is not decoded.
    expect(calls.getTransaction).toBe(1);
  });

  it("a failed transaction: nothing moved, its rows go back on the list", async () => {
    const r = await evaluateRun(
      fakeRpc({ statuses: { [SIG("1")]: { err: { InstructionError: [3, { Custom: 1 }] }, confirmationStatus: "confirmed" }, [SIG("2")]: { err: null, confirmationStatus: "confirmed" } }, height: 10 }).rpc,
      base(),
      { source: SOURCE as Address, destinations: dest, backstop: false },
    );
    expect(r.states.get(A)).toEqual({ state: "todo" });
    expect(r.states.get(B2)).toEqual({ state: "todo" });
    expect(r.states.get(C)).toMatchObject({ state: "done" });
  });

  it("the run's own mint: pending is waited for (never created twice), expired may be made again", async () => {
    const j = { ...base(), mintTx: { signature: SIG("7"), lastValidBlockHeight: "500", amount: "157", reservationId: "res", status: "sent" as const } };
    const confirmedRows = { [SIG("1")]: { err: null, confirmationStatus: "confirmed" }, [SIG("2")]: { err: null, confirmationStatus: "confirmed" } };
    const pending = await evaluateRun(fakeRpc({ statuses: { ...confirmedRows, [SIG("7")]: null }, height: 400 }).rpc, j, { source: SOURCE as Address, destinations: dest });
    expect(pending.mint).toBe("pending");
    expect(pending.journal.mintTx?.status).toBe("sent");
    const expired = await evaluateRun(fakeRpc({ statuses: { ...confirmedRows, [SIG("7")]: null }, height: 600 }).rpc, j, { source: SOURCE as Address, destinations: dest });
    expect(expired.mint).toBe("expired");
    expect(expired.journal.mintTx?.status).toBe("expired");
    // A mint stored as confirmed stays confirmed (never created twice).
    const stored = { ...j, mintTx: { ...j.mintTx, status: "confirmed" as const } };
    const later = await evaluateRun(fakeRpc({ statuses: { ...confirmedRows, [SIG("7")]: null }, height: 600 }).rpc, stored, { source: SOURCE as Address, destinations: dest });
    expect(later.mint).toBe("confirmed");
    expect(later.journal.mintTx?.status).toBe("confirmed");
  });
});

describe("paid before (priorReceipts): any run, any browser", () => {
  const dest = new Map([[A, "dA"], [B2, "dB"], [C, "dC"]]);
  const none = new Map<string, bigint>();

  it("another run of this browser, a transfer in the treasury's history, a balance: each counts; the current run's own does not", () => {
    let other = newJournal({ runId: "old", network: "devnet", mint: MINT, sender: SENDER, rows });
    other = withTx(other, { signature: SIG("1"), lastValidBlockHeight: "1", rows: [A], status: "confirmed", at: "x" });
    other = withTx(other, { signature: SIG("2"), lastValidBlockHeight: "1", rows: [B2], status: "expired", at: "x" });
    let current = newJournal({ runId: "now", network: "devnet", mint: MINT, sender: SENDER, rows });
    current = withTx(current, { signature: SIG("3"), lastValidBlockHeight: "1", rows: [C], status: "sent", at: "x" });
    const history = [
      { signature: SIG("3"), destination: "dC", amount: n(7), blockTime: 5 }, // this run's own transfer
      { signature: SIG("4"), destination: "dB", amount: n(50), blockTime: 4 }, // from another browser
    ];
    const found = priorReceipts({ rows, runId: "now", journals: [other, current], history, destinations: dest, balances: new Map([[C, n(3)]]) });
    expect(found.get(A)).toEqual([{ via: "run", runId: "old" }]);
    // The expired transaction of the other run paid nothing; the chain shows B2 was paid anyway.
    expect(found.get(B2)).toEqual([{ via: "chain", signature: SIG("4"), amount: n(50), blockTime: 4 }]);
    expect(found.get(C)).toEqual([{ via: "balance", amount: n(3) }]);
  });

  it("the same list pasted in another browser (no journal here): every row the treasury paid is flagged", () => {
    const history = rows.map((r, i) => ({ signature: SIG(String(i + 5)), destination: dest.get(r.wallet)!, amount: r.amount, blockTime: 1 }));
    const found = priorReceipts({ rows, runId: "fresh", journals: [], history, destinations: dest, balances: none });
    expect([...found.keys()]).toEqual([A, B2, C]);
    expect(priorReceipts({ rows, runId: "fresh", journals: [], history: [], destinations: dest, balances: none }).size).toBe(0);
  });

  it("the treasury history scan reports the run's own landed signatures and decodes the rest", async () => {
    const decoded: string[] = [];
    const transfer = (dst: string, amount: number): RawTransaction => {
      const b = new Uint8Array(10);
      b[0] = 12;
      new DataView(b.buffer).setBigUint64(1, BigInt(amount), true);
      return {
        blockTime: 10,
        meta: { err: null },
        transaction: { message: { accountKeys: [SENDER, SOURCE, MINT, dst, TOKEN_2022], instructions: [{ programIdIndex: 4, accounts: [1, 2, 3, 0], data: getBase58Decoder().decode(b) }] } },
      };
    };
    const rpc = {
      getSignaturesForAddress: () => ({
        send: async () => [
          { signature: SIG("1"), blockTime: BigInt(10), err: null },
          { signature: SIG("2"), blockTime: BigInt(9), err: { InstructionError: [0, "x"] } },
          { signature: SIG("3"), blockTime: BigInt(8), err: null },
          { signature: SIG("4"), blockTime: BigInt(1), err: null }, // before sinceSec
        ],
      }),
      getTransaction: (sig: string) => ({
        send: async () => {
          decoded.push(sig);
          return sig === SIG("3") ? transfer("dB", 50) : null;
        },
      }),
    } as unknown as Parameters<typeof recentTreasuryTransfers>[0];
    const r = await recentTreasuryTransfers(rpc, { source: SOURCE as Address, mint: MINT as Address, sinceSec: 5, skip: new Set([SIG("1"), SIG("2")]) });
    expect([...r.landed]).toEqual([SIG("1")]);
    expect(decoded).toEqual([SIG("3")]);
    expect(r.transfers).toEqual([{ signature: SIG("3"), destination: "dB", amount: n(50), blockTime: 10 }]);
  });
});

describe("unfinished runs: dismissible once nothing waits for the network", () => {
  const rowsAB = [{ wallet: A, amount: n(1) }, { wallet: B2, amount: n(2) }];
  it("a dismissed or finished run is no longer offered; the journal itself stays (the paid-before check reads it)", () => {
    const a = newJournal({ runId: "a", network: "devnet", mint: MINT, sender: SENDER, rows: rowsAB });
    const b = { ...newJournal({ runId: "b", network: "devnet", mint: MINT, sender: SENDER, rows: rowsAB }), dismissedAt: "2026-10-03T10:00:00Z" };
    const c = { ...newJournal({ runId: "c", network: "devnet", mint: MINT, sender: SENDER, rows: rowsAB }), finishedAt: "2026-10-03T10:00:00Z" };
    expect(unfinishedJournals([a, b, c], null).map((j) => j.runId)).toEqual(["a"]);
    // The list typed now is the current run, not an "unfinished" banner.
    expect(unfinishedJournals([a, b, c], "a")).toEqual([]);
    // Old journals (no field) and a re-sent run (null) count as not dismissed; the field survives storage.
    const store = memoryStore();
    writeJournal(store, b);
    expect(readJournal(store, "devnet", "b")?.dismissedAt).toBe("2026-10-03T10:00:00Z");
  });

  it("refuses to dismiss while a transaction or the mint may still land", () => {
    const j = newJournal({ runId: "r", network: "devnet", mint: MINT, sender: SENDER, rows: rowsAB });
    const now = new Date("2026-10-03T12:00:00Z");
    const pending = dismissJournal(j, { states: new Map([[A, { state: "pending", signature: SIG("1") }]]), mint: null }, now);
    expect(pending).toMatchObject({ problem: expect.stringMatching(/still waiting for the network/) });
    expect(dismissJournal(j, { states: new Map(), mint: "pending" }, now)).toMatchObject({ problem: expect.any(String) });
    const ok = dismissJournal(j, { states: new Map([[A, { state: "todo" }], [B2, { state: "done", signature: SIG("2"), via: "journal" }]]), mint: "expired" }, now);
    expect(ok).toEqual({ journal: { ...j, dismissedAt: now.toISOString() } });
  });
});

describe("audit reconciliation on resume", () => {
  it("owes the final row of every decided transaction and mint not yet marked final; pending and expired owe nothing yet", () => {
    let j = newJournal({ runId: "r", network: "devnet", mint: MINT, sender: SENDER, rows });
    j = withTx(j, { signature: SIG("1"), lastValidBlockHeight: "1", rows: [A], status: "confirmed", at: "x", audited: "pending" });
    j = withTx(j, { signature: SIG("2"), lastValidBlockHeight: "1", rows: [B2], status: "failed", at: "x" });
    j = withTx(j, { signature: SIG("3"), lastValidBlockHeight: "1", rows: [C], status: "confirmed", at: "x", audited: "final" });
    j = withTx(j, { signature: SIG("4"), lastValidBlockHeight: "1", rows: [C], status: "sent", at: "x", audited: "pending" });
    j = withTx(j, { signature: SIG("5"), lastValidBlockHeight: "1", rows: [C], status: "expired", at: "x", audited: "pending" });
    j = { ...j, mintTx: { signature: SIG("6"), lastValidBlockHeight: "1", amount: "10", reservationId: "res", status: "confirmed", audited: "pending" } };
    expect(auditsDue(j)).toEqual([
      { kind: "tx", signature: SIG("1"), rows: [A], status: "success" },
      { kind: "tx", signature: SIG("2"), rows: [B2], status: "failed" },
      { kind: "mint", signature: SIG("6"), amount: "10", reservationId: "res", status: "success" },
    ]);
    // Once written they are marked final and never written twice; "pending" marks never downgrade a final one.
    const marked = withAudited(j, new Set([SIG("1"), SIG("2"), SIG("6")]));
    expect(auditsDue(marked)).toEqual([]);
    expect(withAudited(marked, new Set([SIG("1")]), "pending").txs.find((t) => t.signature === SIG("1"))?.audited).toBe("final");
    // The marks survive storage (old journals without them parse as before).
    const store = memoryStore();
    writeJournal(store, marked);
    expect(auditsDue(readJournal(store, "devnet", "r")!)).toEqual([]);
  });
});

describe("audit rows", () => {
  it("one row per transaction, its recipients and total in the metadata", () => {
    const row = distributionAuditRow({
      actor: SENDER, reason: "Distribution run abcd1234: 2 wallets", scPda: "SC", runId: "r", mint: MINT,
      signature: SIG("1"), status: "pending", rows: [{ wallet: A, amount: n(100) }, { wallet: B2, amount: n(5) }],
    });
    expect(row).toMatchObject({ ix_name: "share_class_distribution", category: "share-class", status: "pending", tx_signature: SIG("1") });
    expect(row.metadata).toMatchObject({ run_id: "r", total: "105", recipients: [{ to: A, amount: "100" }, { to: B2, amount: "5" }] });
  });
});
