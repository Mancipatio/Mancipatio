// Talas 6.3: the e2e step runner over a fake RPC. Negative steps are never
// sent; positive steps are signed once, journalled (inflight, with their
// expiry) before the send and must finalize; a resumed run skips passed
// steps, resolves an inflight signature before sending again (dropped only
// past its lastValidBlockHeight), and trusts a `done` probe only for
// positive steps.
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
type Simulated = { wire: string; sigVerify: boolean; replaceRecentBlockhash: boolean };

/**
 * A fake RPC with a block height (non-zero; `heightStep` advances it per
 * getBlockHeight call) and a blockhash valid for 150 blocks. `landing:
 * "never"` models a transaction that never lands: its status stays null
 * while the height passes its lastValidBlockHeight.
 */
function fakeRpc(input: {
  simulate: (call: Simulated) => Sim;
  history?: Status;
  landing?: Status | "never";
  height?: bigint;
  heightStep?: bigint;
  onSend?: () => void;
}) {
  const calls: string[] = [];
  const sent: string[] = [];
  const simulated: Simulated[] = [];
  let height = input.height ?? BigInt(5_000);
  let landed: Status = null;
  const rpc = {
    getLatestBlockhash: () => ({
      send: async () => (calls.push("getLatestBlockhash"), { value: { blockhash: BLOCKHASH, lastValidBlockHeight: height + BigInt(150) } }),
    }),
    simulateTransaction: (wire: string, config: { sigVerify?: boolean; replaceRecentBlockhash?: boolean }) => ({
      send: async () => {
        calls.push("simulateTransaction");
        const call = { wire, sigVerify: config.sigVerify === true, replaceRecentBlockhash: config.replaceRecentBlockhash === true };
        simulated.push(call);
        return { value: input.simulate(call) };
      },
    }),
    sendTransaction: (wire: string) => ({
      send: async () => {
        calls.push("sendTransaction");
        sent.push(wire);
        input.onSend?.();
        if (input.landing !== "never") landed = input.landing ?? { err: null, confirmationStatus: "finalized" };
        return "sig";
      },
    }),
    getSignatureStatuses: (_sigs: string[], config?: { searchTransactionHistory?: boolean }) => ({
      send: async () => {
        calls.push(config?.searchTransactionHistory ? "getSignatureStatuses(history)" : "getSignatureStatuses");
        return { value: [config?.searchTransactionHistory && input.history !== undefined ? input.history : landed] };
      },
    }),
    getBlockHeight: () => ({
      send: async () => {
        calls.push("getBlockHeight");
        const now = height;
        height += input.heightStep ?? BigInt(0);
        return now;
      },
    }),
  } as unknown as ChainRpc;
  return { rpc, calls, sent, simulated };
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
    expect(saved.status === "passed" && saved.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
  });

  it("signs once: sized unsigned at MAX CU, then the exact signed wire is simulated with sigVerify and sent", async () => {
    const payer = await generateKeyPairSigner();
    let inflight: unknown = null;
    let dir = "";
    const fake = fakeRpc({ simulate: () => ok, onSend: () => (inflight = loadState(dir)!.steps["1.7"]) });
    const setupResult = setup(fake.rpc);
    dir = setupResult.dir;
    await expect(setupResult.runner.step("1.7", async () => ({ payer, ixs: [ix] }))).resolves.toBe("passed");
    expect(fake.simulated.map((c) => [c.sigVerify, c.replaceRecentBlockhash])).toEqual([
      [false, true],
      [true, false],
    ]);
    expect(fake.sent).toEqual([fake.simulated[1].wire]);
    expect(fake.calls.filter((c) => c === "getLatestBlockhash")).toHaveLength(1);
    // Recorded inflight before the send, with the blockhash's expiry.
    expect(inflight).toMatchObject({ status: "inflight", lastValidBlockHeight: "5150" });
  });

  it("a negative step is simulated once, signed, with sigVerify", async () => {
    const payer = await generateKeyPairSigner();
    const fake = fakeRpc({ simulate: () => soldOut });
    const { runner } = setup(fake.rpc);
    await runner.step("2.4c", async () => ({ payer, ixs: [ix] }));
    expect(fake.simulated).toHaveLength(1);
    expect(fake.simulated[0]).toMatchObject({ sigVerify: true, replaceRecentBlockhash: false });
  });

  it("a signed simulation that fails after a clean sizing is a mismatch and is not sent", async () => {
    const payer = await generateKeyPairSigner();
    const fake = fakeRpc({ simulate: (call) => (call.sigVerify ? soldOut : ok) });
    const { runner, dir } = setup(fake.rpc);
    await expect(runner.step("1.7", async () => ({ payer, ixs: [ix] }))).rejects.toThrow(/expected success, simulation failed/);
    expect(fake.sent).toEqual([]);
    expect(loadState(dir)!.steps["1.7"].status).toBe("failed");
  });

  it("a transaction that never lands is dropped once the block height passes its expiry; the step can be sent again", async () => {
    const payer = await generateKeyPairSigner();
    const fake = fakeRpc({ simulate: () => ok, landing: "never", heightStep: BigInt(100) });
    const { runner, dir } = setup(fake.rpc);
    await expect(runner.step("1.7", async () => ({ payer, ixs: [ix] }))).rejects.toThrow(/expired without landing/);
    expect(fake.sent.length).toBeGreaterThanOrEqual(1);
    expect(new Set(fake.sent)).toEqual(new Set([fake.simulated[1].wire]));
    expect(fake.calls).toContain("getSignatureStatuses(history)");
    expect(loadState(dir)!.steps["1.7"]).toBeUndefined();
  });

  it("a signer other than the role recorded for the step is refused before any RPC call", async () => {
    const payer = await generateKeyPairSigner();
    const admin = await generateKeyPairSigner();
    const fake = fakeRpc({ simulate: () => ok });
    const state = newState({ network: "devnet", genesis: "G", runId: "abcd12" });
    state.roles = { admin: admin.address, funder: payer.address };
    const { runner } = setup(fake.rpc, { state });
    await expect(runner.step("1.7", async () => ({ payer, ixs: [ix] }))).rejects.toThrow(/not by the admin recorded in state.json/);
    expect(fake.calls).toEqual([]);
    // The funder is its own role: its key signs 1.0.
    await expect(runner.step("1.0", async () => ({ payer, ixs: [ix] }))).resolves.toBe("passed");
    await expect(runner.step("1.7", async () => ({ payer: admin, ixs: [ix] }))).resolves.toBe("passed");
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

  it("an inflight signature that never landed is sent again once its blockhash expired; one that failed stops the run", async () => {
    const payer = await generateKeyPairSigner();
    const state = newState({ network: "devnet", genesis: "G", runId: "abcd12" });
    state.steps["1.10"] = { status: "inflight", signature: "5".repeat(88), lastValidBlockHeight: "4000", at: "t" };
    const dropped = fakeRpc({ simulate: () => ok, history: null, height: BigInt(5_000) });
    await expect(setup(dropped.rpc, { state: structuredClone(state) }).runner.step("1.10", async () => ({ payer, ixs: [ix] }))).resolves.toBe("passed");
    expect(dropped.sent).toHaveLength(1);
    const failed = fakeRpc({ simulate: () => ok, history: { err: { InstructionError: [0, { Custom: 1 }] }, confirmationStatus: "finalized" } });
    await expect(setup(failed.rpc, { state: structuredClone(state) }).runner.step("1.10", async () => ({ payer, ixs: [ix] }))).rejects.toThrow(
      /landed with an error in an earlier run/,
    );
    expect(failed.sent).toEqual([]);
  });

  it("an unseen inflight signature whose blockhash has not expired halts without sending", async () => {
    const payer = await generateKeyPairSigner();
    const state = newState({ network: "devnet", genesis: "G", runId: "abcd12" });
    state.steps["1.10"] = { status: "inflight", signature: "5".repeat(88), lastValidBlockHeight: "5000", at: "t" };
    const fake = fakeRpc({ simulate: () => ok, history: null, height: BigInt(5_000) });
    const { runner, dir } = setup(fake.rpc, { state });
    await expect(runner.step("1.10", async () => ({ payer, ixs: [ix] }))).rejects.toThrow(
      expect.objectContaining({ name: "ChainHaltError", message: expect.stringMatching(/has not expired/) }),
    );
    expect(fake.sent).toEqual([]);
    expect(fake.calls).toEqual(["getSignatureStatuses(history)", "getBlockHeight"]);
    expect(loadState(dir)?.steps["1.10"] ?? state.steps["1.10"]).toMatchObject({ status: "inflight" });
  });

  it("an unseen inflight signature without a recorded expiry halts (never assumed dropped)", async () => {
    const payer = await generateKeyPairSigner();
    const state = newState({ network: "devnet", genesis: "G", runId: "abcd12" });
    state.steps["1.10"] = { status: "inflight", signature: "5".repeat(88), at: "t" };
    const fake = fakeRpc({ simulate: () => ok, history: null, height: BigInt(9_000) });
    await expect(setup(fake.rpc, { state }).runner.step("1.10", async () => ({ payer, ixs: [ix] }))).rejects.toThrow(
      expect.objectContaining({ name: "ChainHaltError", message: expect.stringMatching(/expiry was not recorded/) }),
    );
    expect(fake.sent).toEqual([]);
  });

  it("an expired inflight signature is looked up once more before it is called dropped", async () => {
    const payer = await generateKeyPairSigner();
    const state = newState({ network: "devnet", genesis: "G", runId: "abcd12" });
    state.steps["1.10"] = { status: "inflight", signature: "5".repeat(88), lastValidBlockHeight: "4000", at: "t" };
    const fake = fakeRpc({ simulate: () => ok, history: null });
    const { runner, journal } = setup(fake.rpc, { state });
    await runner.step("1.10", async () => ({ payer, ixs: [ix] }));
    expect(fake.calls.slice(0, 3)).toEqual(["getSignatureStatuses(history)", "getBlockHeight", "getSignatureStatuses(history)"]);
    expect(readJournal(journal.path).map((e) => e.event)).toContain("e2e-dropped");
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

  it("the budget is checked again after the simulations: reaching it (count === max) sends and records nothing", async () => {
    const payer = await generateKeyPairSigner();
    const fake = fakeRpc({ simulate: () => ok });
    // blockhash + sizing + signed simulation = 3 calls.
    const { runner, dir } = setup(fake.rpc, { requests: () => fake.calls.length, max: 3 });
    await expect(runner.step("1.7", async () => ({ payer, ixs: [ix] }))).rejects.toThrow(/E2E_MAX_REQUESTS \(3\)/);
    expect(fake.calls).toEqual(["getLatestBlockhash", "simulateTransaction", "simulateTransaction"]);
    expect(fake.sent).toEqual([]);
    expect(loadState(dir)?.steps["1.7"]).toBeUndefined();
  });

  it("a budget already at its maximum stops before any call", async () => {
    const payer = await generateKeyPairSigner();
    const fake = fakeRpc({ simulate: () => ok });
    const { runner } = setup(fake.rpc, { requests: () => 10, max: 10 });
    await expect(runner.step("1.7", async () => ({ payer, ixs: [ix] }))).rejects.toThrow(/E2E_MAX_REQUESTS/);
    expect(fake.calls).toEqual([]);
  });

  it("notRun records a skipped step that never counts as passed, and a later run evaluates it again", async () => {
    const payer = await generateKeyPairSigner();
    const notStarted: Sim = { err: { InstructionError: [0, { Custom: 6019 }] }, logs: [SOLD_OUT_LOGS[1]], unitsConsumed: BigInt(0) };
    const fake = fakeRpc({ simulate: () => notStarted });
    const { runner, dir } = setup(fake.rpc);
    let built = false;
    await expect(
      runner.step("2.7c", async () => ((built = true), { payer, ixs: [ix] }), { notRun: async () => "sale #5 started" }),
    ).resolves.toBe("not-run");
    expect(built).toBe(false);
    expect(fake.calls).toEqual([]);
    expect(runner.passed("2.7c")).toBe(false);
    expect(loadState(dir)!.steps["2.7c"]).toMatchObject({ status: "skipped", detail: "sale #5 started" });
    expect(runner.results.at(-1)).toMatchObject({ id: "2.7c", outcome: "not-run", actual: "sale #5 started" });
    // Next run: the guard no longer applies → the step runs.
    await expect(runner.step("2.7c", async () => ({ payer, ixs: [ix] }), { notRun: async () => null })).resolves.toBe("passed");
    // A passed step is never downgraded.
    runner.markNotRun("2.7c", "late");
    expect(runner.passed("2.7c")).toBe(true);
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
