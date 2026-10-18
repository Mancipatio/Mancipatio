import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBase58Decoder } from "@solana/kit";
import {
  assertChainRecordStorageAvailable,
  checkPendingChainRecord,
  clearPendingChainRecord,
  discardableChainRecordState,
  discardPendingChainRecord,
  isAwaitingFinalizationError,
  listPendingChainRecords,
  pastReceiptHorizon,
  readPendingChainRecord,
  RECEIPT_EXPIRY_HORIZON_MS,
  RECORD_MAX_RETRIES,
  RECORD_RETRY_DELAYS_MS,
  receiptChainState,
  recordOnceFinalized,
  savePendingChainRecord,
  waitForFinalizedSignature,
  type ChainRecordRpc,
  type ChainRecordScope,
  type ChainRecordState,
  type FinalizedSignatureOutcome,
  type RecordingStage,
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

// F075: what became of a receipt's transaction, and when it may be discarded.
const T0 = 1_700_000_000_000;
const createdAt = new Date(T0).toISOString();
const atHorizon = T0 + RECEIPT_EXPIRY_HORIZON_MS;
type FakeStatus = { err: unknown; confirmationStatus?: string | null } | null;
function fakeRpc(opts: {
  status?: FakeStatus | (() => FakeStatus);
  tx?: { meta: { err: unknown } | null } | null;
  fail?: "status" | "tx";
}) {
  const calls: string[] = [];
  const rpc = {
    getSignatureStatuses: (sigs: string[], config: unknown) => ({
      send: async () => {
        calls.push(`status:${sigs.join(",")}:${JSON.stringify(config)}`);
        if (opts.fail === "status") throw new Error("rpc down");
        const status =
          typeof opts.status === "function" ? opts.status() : (opts.status ?? null);
        return { context: { slot: BigInt(1) }, value: [status] };
      },
    }),
    getTransaction: (sig: string, config: { commitment: string }) => ({
      send: async () => {
        calls.push(`tx:${sig}:${config.commitment}`);
        if (opts.fail === "tx") throw new Error("rpc down");
        return opts.tx ?? null;
      },
    }),
  } as unknown as ChainRecordRpc;
  return { rpc, calls };
}

describe("receipt chain state (F075)", () => {
  it("the horizon is 6 h after the receipt was saved (the server's own: lib/server/distribution-audits.ts)", () => {
    expect(RECEIPT_EXPIRY_HORIZON_MS).toBe(6 * 60 * 60_000);
    expect(pastReceiptHorizon(createdAt, atHorizon - 1)).toBe(false);
    expect(pastReceiptHorizon(createdAt, atHorizon)).toBe(true);
    expect(pastReceiptHorizon("not a date", atHorizon)).toBe(false);
  });
  it.each<[string, FakeStatus, { meta: { err: unknown } | null } | null | undefined, number, ChainRecordState]>([
    ["finalized without error", { err: null, confirmationStatus: "finalized" }, undefined, T0, "landed"],
    ["confirmed without error", { err: null, confirmationStatus: "confirmed" }, undefined, T0, "landed"],
    ["processed without error", { err: null, confirmationStatus: "processed" }, undefined, atHorizon, "pending"],
    ["finalized with an error", { err: { x: 1 }, confirmationStatus: "finalized" }, undefined, T0, "failed"],
    ["confirmed with an error (waits for finalized)", { err: { x: 1 }, confirmationStatus: "confirmed" }, undefined, T0, "pending"],
    ["processed with an error", { err: { x: 1 }, confirmationStatus: "processed" }, undefined, atHorizon, "pending"],
    ["unknown, before the horizon", null, undefined, atHorizon - 1, "pending"],
    ["unknown at the horizon, transaction not read", null, undefined, atHorizon, "pending"],
    ["unknown at the horizon, no transaction at finalized", null, null, atHorizon, "did_not_land"],
    ["unknown at the horizon, transaction with an error", null, { meta: { err: { x: 1 } } }, atHorizon, "failed"],
    ["unknown at the horizon, transaction without error", null, { meta: { err: null } }, atHorizon, "landed"],
  ])("%s", (_label, status, tx, now, expected) => {
    expect(receiptChainState(status, tx, createdAt, now)).toBe(expected);
  });
  it("asks for the transaction only past the horizon and only when the status is unknown", async () => {
    const receipt = { signature: SIGNATURE, createdAt };
    const early = fakeRpc({ status: null, tx: null });
    expect(await checkPendingChainRecord(early.rpc, receipt, atHorizon - 1)).toBe("pending");
    expect(early.calls).toEqual([`status:${SIGNATURE}:{"searchTransactionHistory":true}`]);
    const known = fakeRpc({ status: { err: null, confirmationStatus: "finalized" }, tx: null });
    expect(await checkPendingChainRecord(known.rpc, receipt, atHorizon)).toBe("landed");
    expect(known.calls).toHaveLength(1);
    const dead = fakeRpc({ status: null, tx: null });
    expect(await checkPendingChainRecord(dead.rpc, receipt, atHorizon)).toBe("did_not_land");
    expect(dead.calls[1]).toBe(`tx:${SIGNATURE}:finalized`);
    const failed = fakeRpc({ status: null, tx: { meta: { err: { x: 1 } } } });
    expect(await checkPendingChainRecord(failed.rpc, receipt, atHorizon)).toBe("failed");
    expect(await checkPendingChainRecord(fakeRpc({ fail: "status" }).rpc, receipt, atHorizon)).toBe("unknown");
    expect(await checkPendingChainRecord(fakeRpc({ status: null, fail: "tx" }).rpc, receipt, atHorizon)).toBe("unknown");
  });
  it("discards a receipt only in a dead state, and only the stored signature", () => {
    const saved = savePendingChainRecord({ ...scope, signature: SIGNATURE });
    for (const state of ["pending", "landed", "unknown"] as const) {
      expect(discardableChainRecordState(state)).toBe(false);
      expect(discardPendingChainRecord(saved, state)).toBe(false);
      expect(readPendingChainRecord(scope)).toEqual(saved);
    }
    expect(discardableChainRecordState("failed")).toBe(true);
    expect(discardableChainRecordState("did_not_land")).toBe(true);
    expect(discardPendingChainRecord({ ...saved, signature: NEXT_SIGNATURE }, "did_not_land")).toBe(false);
    expect(readPendingChainRecord(scope)).toEqual(saved);
    expect(discardPendingChainRecord(saved, "did_not_land")).toBe(true);
    expect(readPendingChainRecord(scope)).toBeNull();
    expect(discardPendingChainRecord(saved, "failed")).toBe(false);
  });
});

// F072: the wait for finalization, and the record that follows it once.
describe("waiting for a signature to finalize", () => {
  const wait = (rpc: ChainRecordRpc, timeoutMs = 40) =>
    waitForFinalizedSignature(rpc, SIGNATURE, { timeoutMs, pollMs: 2, retryReads: false });
  it("keeps polling through confirmed, resolves at finalized, with the history searched", async () => {
    const seen: string[] = ["processed", "confirmed", "confirmed", "finalized"];
    const { rpc, calls } = fakeRpc({
      status: () => ({ err: null, confirmationStatus: seen.shift() ?? "finalized" }),
    });
    expect(await wait(rpc, 1_000)).toBe("finalized");
    expect(calls).toHaveLength(4);
    expect(calls[0]).toContain('"searchTransactionHistory":true');
  });
  it("an error is failed only at finalized (a receipt is discarded on it); at processed or confirmed it keeps polling", async () => {
    expect(await wait(fakeRpc({ status: { err: { x: 1 }, confirmationStatus: "confirmed" } }).rpc)).toBe("timeout");
    const seen: string[] = ["processed", "confirmed", "finalized"];
    const { rpc, calls } = fakeRpc({ status: () => ({ err: { x: 1 }, confirmationStatus: seen.shift() ?? "finalized" }) });
    expect(await wait(rpc, 1_000)).toBe("failed");
    expect(calls).toHaveLength(3);
  });
  it("a status that never arrives is a timeout; an unreadable one is unknown", async () => {
    expect(await wait(fakeRpc({ status: null }).rpc)).toBe("timeout");
    expect(await wait(fakeRpc({ fail: "status" }).rpc)).toBe("unknown");
  });
});

describe("recordOnceFinalized: wait, then one signed record", () => {
  function harness(outcomes: FinalizedSignatureOutcome[], recordErrors: (Error | null)[] = []) {
    const stages: string[] = [];
    const waits: number[] = [];
    const sleeps: number[] = [];
    const record = vi.fn(async () => {
      const error = recordErrors.shift();
      if (error) throw error;
    });
    const run = () =>
      recordOnceFinalized({
        waitForFinalized: async (timeoutMs) => {
          waits.push(timeoutMs);
          return outcomes.shift() ?? "timeout";
        },
        record,
        onStage: (stage: RecordingStage, attempt) => stages.push(`${stage}:${attempt}`),
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        waitMs: 60_000,
        recheckMs: 10_000,
      });
    return { run, stages, waits, sleeps, record };
  }
  const awaiting = () => new Error("Awaiting finalization: the network does not show this transaction as finalized yet");
  it("finalized: records once, no backoff", async () => {
    const h = harness(["finalized"]);
    expect(await h.run()).toBe("recorded");
    expect(h.record).toHaveBeenCalledOnce();
    expect(h.stages).toEqual(["awaiting_finalization:0", "recording:0"]);
    expect(h.waits).toEqual([60_000]);
    expect(h.sleeps).toEqual([]);
  });
  it("failed: nothing is recorded", async () => {
    const h = harness(["failed"]);
    expect(await h.run()).toBe("failed");
    expect(h.record).not.toHaveBeenCalled();
  });
  it("a timeout backs off 5 s, 15 s, 30 s, reading the status again each time, before giving the receipt to the manual retry", async () => {
    const h = harness(["timeout", "unknown", "timeout", "timeout"]);
    expect(await h.run()).toBe("not_finalized");
    expect(h.record).not.toHaveBeenCalled();
    expect(h.sleeps).toEqual([...RECORD_RETRY_DELAYS_MS]);
    expect(RECORD_RETRY_DELAYS_MS).toEqual([5_000, 15_000, 30_000]);
    expect(h.waits).toEqual([60_000, 10_000, 10_000, 10_000]);
    expect(h.stages).toEqual([
      "awaiting_finalization:0", "retry_wait:1", "awaiting_finalization:1", "retry_wait:2", "awaiting_finalization:2", "retry_wait:3", "awaiting_finalization:3",
    ]);
  });
  it("finalized after a backoff: records then; a server answering 'awaiting finalization' gets the signed record once more, after the next backoff and read, then the manual retry", async () => {
    const late = harness(["timeout", "finalized"]);
    expect(await late.run()).toBe("recorded");
    expect(late.record).toHaveBeenCalledOnce();
    expect(late.sleeps).toEqual([5_000]);
    const lagging = harness(["finalized", "finalized"], [awaiting(), null]);
    expect(await lagging.run()).toBe("recorded");
    expect(lagging.record).toHaveBeenCalledTimes(2);
    expect(lagging.sleeps).toEqual([5_000]);
    expect(lagging.waits).toEqual([60_000, 10_000]);
    // Each signed record is a wallet prompt: at most one more than the first.
    expect(RECORD_MAX_RETRIES).toBe(1);
    const stuck = harness(["finalized", "finalized", "finalized"], [awaiting(), awaiting(), awaiting()]);
    expect(await stuck.run()).toBe("not_finalized");
    expect(stuck.record).toHaveBeenCalledTimes(2);
    expect(stuck.sleeps).toEqual([5_000]);
    // A wait that runs out between the two costs no prompt and keeps its backoffs.
    const lapsed = harness(["finalized", "timeout", "finalized"], [awaiting(), awaiting()]);
    expect(await lapsed.run()).toBe("not_finalized");
    expect(lapsed.record).toHaveBeenCalledTimes(2);
    expect(lapsed.sleeps).toEqual([5_000, 15_000]);
  });

  it("a failed transaction found on a recheck ends the attempt; any other record error is thrown as it is", async () => {
    const h = harness(["timeout", "failed"]);
    expect(await h.run()).toBe("failed");
    const refused = harness(["finalized"], [new Error("Custody vault terms do not match this request")]);
    await expect(refused.run()).rejects.toThrow("terms do not match");
    expect(refused.sleeps).toEqual([]);
  });
  it("recognizes the server's refusal by code or by its opening words", () => {
    expect(isAwaitingFinalizationError(Object.assign(new Error("x"), { code: "awaiting_finalization" }))).toBe(true);
    expect(isAwaitingFinalizationError(awaiting())).toBe(true);
    expect(isAwaitingFinalizationError(new Error("Return is awaiting finalization. Retry recording"))).toBe(true);
    expect(isAwaitingFinalizationError("Awaiting finalization: later")).toBe(true);
    expect(isAwaitingFinalizationError(new Error("Custody vault terms do not match this request"))).toBe(false);
    expect(isAwaitingFinalizationError(null)).toBe(false);
  });
});
