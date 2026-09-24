// Talas 6.3: the e2e step runner over a fake RPC. Negative steps are never
// sent; positive steps are journalled (inflight) before the send and must
// finalize; a resumed run skips passed steps, resolves an inflight signature
// before sending again, and trusts a `done` probe only for positive steps.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateKeyPairSigner, type Instruction } from "@solana/kit";
import { ASSET_REGISTRY_PROGRAM_ADDRESS } from "@/lib/generated/asset_registry";
import { Journal, readJournal } from "@/scripts/chain/lib/journal";
import type { ChainRpc } from "@/scripts/chain/lib/rpc";
import { E2eRunner } from "@/scripts/chain/lib/e2e/runner";
import { loadState, newState, type E2eState } from "@/scripts/chain/lib/e2e/state";
import { tempDir } from "./helpers/chain-fake";

const BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";
const ix: Instruction = { programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS, data: new Uint8Array([1]) };
const SOLD_OUT_LOGS = [
  "Program log: AnchorError occurred. Error Code: SaleSoldOut. Error Number: 6021. Error Message: x.",
  `Program ${ASSET_REGISTRY_PROGRAM_ADDRESS} failed: custom program error: 0x1785`,
];

type Sim = { err: unknown; logs: string[]; unitsConsumed: bigint };
type Status = { err: unknown; confirmationStatus: string } | null;

function fakeRpc(input: { simulate: () => Sim; history?: Status; landing?: Status }) {
  const calls: string[] = [];
  const sent: string[] = [];
  let landed: Status = null;
  const rpc = {
    getLatestBlockhash: () => ({
      send: async () => (calls.push("getLatestBlockhash"), { value: { blockhash: BLOCKHASH, lastValidBlockHeight: BigInt(1000) } }),
    }),
    simulateTransaction: () => ({ send: async () => (calls.push("simulateTransaction"), { value: input.simulate() }) }),
    sendTransaction: (wire: string) => ({
      send: async () => {
        calls.push("sendTransaction");
        sent.push(wire);
        landed = input.landing ?? { err: null, confirmationStatus: "finalized" };
        return "sig";
      },
    }),
    getSignatureStatuses: (_sigs: string[], config?: { searchTransactionHistory?: boolean }) => ({
      send: async () => {
        calls.push(config?.searchTransactionHistory ? "getSignatureStatuses(history)" : "getSignatureStatuses");
        return { value: [config?.searchTransactionHistory && input.history !== undefined ? input.history : landed] };
      },
    }),
    getBlockHeight: () => ({ send: async () => (calls.push("getBlockHeight"), BigInt(0)) }),
  } as unknown as ChainRpc;
  return { rpc, calls, sent };
}

function setup(rpc: ChainRpc, options: { network?: "devnet" | "localnet"; state?: E2eState; requests?: () => number; max?: number } = {}) {
  const dir = tempDir("e2e-runner-");
  const state = options.state ?? newState({ network: options.network ?? "devnet", genesis: "G", runId: "abcd12" });
  const journal = new Journal(path.join(dir, "journal.jsonl"));
  const logs: string[] = [];
  const runner = new E2eRunner({
    network: options.network ?? "devnet",
    groups: [1, 2, 3],
    dir,
    state,
    rpc,
    drainRpc: rpc,
    journal,
    cuPrice: null,
    signal: new AbortController().signal,
    timing: { pollMs: 0, rebroadcastMs: 0, sleep: async () => {} },
    log: (line) => logs.push(line),
    requestCount: options.requests ?? (() => 0),
    maxRequests: options.max ?? 1000,
  });
  return { runner, dir, journal, logs };
}

const ok: Sim = { err: null, logs: [], unitsConsumed: BigInt(5000) };
const soldOut: Sim = { err: { InstructionError: [0, { Custom: 6021 }] }, logs: SOLD_OUT_LOGS, unitsConsumed: BigInt(0) };

describe("E2eRunner negative steps", () => {
  it("a refusal with the expected program and code passes and is never sent", async () => {
    const payer = await generateKeyPairSigner();
    const fake = fakeRpc({ simulate: () => soldOut });
    const { runner, dir } = setup(fake.rpc);
    await expect(runner.step("2.4c", async () => ({ payer, ixs: [ix] }))).resolves.toBe("passed");
    expect(fake.sent).toEqual([]);
    const saved = loadState(dir)!.steps["2.4c"];
    expect(saved).toMatchObject({ status: "passed", signature: null, actual: { program: "asset_registry", code: 6021 } });
  });

  it("a negative step that simulates cleanly is a mismatch, and is still not sent", async () => {
    const payer = await generateKeyPairSigner();
    const fake = fakeRpc({ simulate: () => ok });
    const { runner, dir } = setup(fake.rpc);
    await expect(runner.step("2.4c", async () => ({ payer, ixs: [ix] }))).rejects.toThrow(/expected asset_registry SaleSoldOut \(6021\), got ok/);
    expect(fake.sent).toEqual([]);
    expect(loadState(dir)!.steps["2.4c"].status).toBe("failed");
  });

  it("a refusal with another code is a mismatch", async () => {
    const payer = await generateKeyPairSigner();
    const fake = fakeRpc({ simulate: () => ({ ...soldOut, err: { InstructionError: [0, { Custom: 6019 }] }, logs: [SOLD_OUT_LOGS[1]] }) });
    const { runner } = setup(fake.rpc);
    await expect(runner.step("2.4c", async () => ({ payer, ixs: [ix] }))).rejects.toThrow(/got asset_registry: SaleNotStarted \(6019\)/);
  });

  it("a done probe never skips a negative step", async () => {
    const payer = await generateKeyPairSigner();
    const fake = fakeRpc({ simulate: () => soldOut });
    const { runner } = setup(fake.rpc);
    let probed = false;
    await runner.step("2.4c", async () => ({ payer, ixs: [ix] }), { done: async () => ((probed = true), true) });
    expect(probed).toBe(false);
    expect(fake.calls).toContain("simulateTransaction");
  });
});

describe("E2eRunner positive steps", () => {
  it("a failing simulation stops the run before anything is sent", async () => {
    const payer = await generateKeyPairSigner();
    const fake = fakeRpc({ simulate: () => soldOut });
    const { runner, dir } = setup(fake.rpc);
    await expect(runner.step("1.7", async () => ({ payer, ixs: [ix] }))).rejects.toThrow(/expected success, simulation failed/);
    expect(fake.sent).toEqual([]);
    expect(loadState(dir)!.steps["1.7"].status).toBe("failed");
  });

  it("is journalled (signed) before the send, sent once and recorded with its signature", async () => {
    const payer = await generateKeyPairSigner();
    const fake = fakeRpc({ simulate: () => ok });
    const { runner, dir, journal } = setup(fake.rpc);
    await expect(runner.step("1.7", async () => ({ payer, ixs: [ix] }))).resolves.toBe("passed");
    expect(fake.sent).toHaveLength(1);
    const events = readJournal(journal.path).map((e) => e.event);
    expect(events.indexOf("signed")).toBeLessThan(events.indexOf("sent"));
    expect(events).toContain("e2e-step");
    const saved = loadState(dir)!.steps["1.7"];
    expect(saved.status).toBe("passed");
    expect(saved.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
  });

  it("a transaction that lands with an error stops the run", async () => {
    const payer = await generateKeyPairSigner();
    const fake = fakeRpc({ simulate: () => ok, landing: { err: { InstructionError: [0, { Custom: 6000 }] }, confirmationStatus: "finalized" } });
    const { runner, dir } = setup(fake.rpc);
    await expect(runner.step("1.7", async () => ({ payer, ixs: [ix] }))).rejects.toThrow(/failed on-chain/);
    expect(loadState(dir)!.steps["1.7"].status).toBe("failed");
  });
});

describe("E2eRunner resume", () => {
  it("skips a step an earlier run passed, without any RPC call", async () => {
    const payer = await generateKeyPairSigner();
    const fake = fakeRpc({ simulate: () => ok });
    const state = newState({ network: "devnet", genesis: "G", runId: "abcd12" });
    state.steps["1.7"] = { status: "passed", signature: "earlier", actual: null, at: "t" };
    const { runner } = setup(fake.rpc, { state });
    let built = false;
    await expect(runner.step("1.7", async () => ((built = true), { payer, ixs: [ix] }))).resolves.toBe("skipped");
    expect(built).toBe(false);
    expect(fake.calls).toEqual([]);
  });

  it("records a positive step the chain already shows (done) without sending", async () => {
    const payer = await generateKeyPairSigner();
    const fake = fakeRpc({ simulate: () => ok });
    const { runner, dir } = setup(fake.rpc);
    await expect(runner.step("1.7", async () => ({ payer, ixs: [ix] }), { done: async () => true })).resolves.toBe("skipped");
    expect(fake.sent).toEqual([]);
    expect(loadState(dir)!.steps["1.7"]).toMatchObject({ status: "passed", signature: null });
  });

  it("an inflight signature that finalized is not sent again", async () => {
    const payer = await generateKeyPairSigner();
    const fake = fakeRpc({ simulate: () => ok, history: { err: null, confirmationStatus: "finalized" } });
    const state = newState({ network: "devnet", genesis: "G", runId: "abcd12" });
    state.steps["1.10"] = { status: "inflight", signature: "5".repeat(88), at: "t" };
    const { runner, dir } = setup(fake.rpc, { state });
    await expect(runner.step("1.10", async () => ({ payer, ixs: [ix] }))).resolves.toBe("skipped");
    expect(fake.sent).toEqual([]);
    expect(loadState(dir)!.steps["1.10"].status).toBe("passed");
  });

  it("an inflight signature that never landed is sent again; one that failed stops the run", async () => {
    const payer = await generateKeyPairSigner();
    const state = newState({ network: "devnet", genesis: "G", runId: "abcd12" });
    state.steps["1.10"] = { status: "inflight", signature: "5".repeat(88), at: "t" };
    const dropped = fakeRpc({ simulate: () => ok, history: null });
    await expect(setup(dropped.rpc, { state: structuredClone(state) }).runner.step("1.10", async () => ({ payer, ixs: [ix] }))).resolves.toBe("passed");
    expect(dropped.sent).toHaveLength(1);
    const failed = fakeRpc({ simulate: () => ok, history: { err: { InstructionError: [0, { Custom: 1 }] }, confirmationStatus: "finalized" } });
    await expect(setup(failed.rpc, { state: structuredClone(state) }).runner.step("1.10", async () => ({ payer, ixs: [ix] }))).rejects.toThrow(
      /landed with an error in an earlier run/,
    );
    expect(failed.sent).toEqual([]);
  });

  it("an inflight signature that is not finalized yet halts without sending", async () => {
    const payer = await generateKeyPairSigner();
    const state = newState({ network: "devnet", genesis: "G", runId: "abcd12" });
    state.steps["1.10"] = { status: "inflight", signature: "5".repeat(88), at: "t" };
    const pending = fakeRpc({ simulate: () => ok, history: { err: null, confirmationStatus: "confirmed" } });
    await expect(setup(pending.rpc, { state }).runner.step("1.10", async () => ({ payer, ixs: [ix] }))).rejects.toThrow(/not finalized yet/);
    expect(pending.sent).toEqual([]);
  });
});

describe("E2eRunner scope and budget", () => {
  it("a step of another network or group is not applicable and touches nothing", async () => {
    const payer = await generateKeyPairSigner();
    const fake = fakeRpc({ simulate: () => ok });
    const { runner } = setup(fake.rpc, { network: "devnet" });
    await expect(runner.step("1.11", async () => ({ payer, ixs: [ix] }))).resolves.toBe("not-applicable");
    await expect(runner.step("0.1", async () => ({ payer, ixs: [ix] }))).resolves.toBe("not-applicable");
    expect(fake.calls).toEqual([]);
  });

  it("stops at the request budget", async () => {
    const payer = await generateKeyPairSigner();
    const fake = fakeRpc({ simulate: () => ok });
    const { runner } = setup(fake.rpc, { requests: () => 11, max: 10 });
    await expect(runner.step("1.7", async () => ({ payer, ixs: [ix] }))).rejects.toThrow(/E2E_MAX_REQUESTS/);
    expect(fake.calls).toEqual([]);
  });

  it("markPassed records a checkpoint step", () => {
    const fake = fakeRpc({ simulate: () => ok });
    const { runner, dir } = setup(fake.rpc);
    runner.markPassed("1.3", "KYB verified in the browser");
    expect(runner.passed("1.3")).toBe(true);
    expect(loadState(dir)!.steps["1.3"]).toMatchObject({ status: "passed", signature: null });
    expect(fs.existsSync(path.join(dir, "state.json"))).toBe(true);
  });
});
