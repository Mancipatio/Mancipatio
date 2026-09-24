// Talas 6.3: the chain:e2e tool's gates over a FakeChain (no validator, no
// devnet): dry run prints the digest and sends nothing; a wrong digest, an
// unimplemented group, a non-ignored E2E_DIR and a held E2E_DIR lock are
// refused before any key is loaded. Plus the pieces those gates rely on:
// the E2E_DIR lock, the role comparison on resume, the summary's stopped
// steps and the checkpoint wait.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runTool } from "@/scripts/chain/lib/context";
import { CHECKPOINT_MAX_TRANSIENT, waitForCheckpoint } from "@/scripts/chain/lib/e2e/checkpoint";
import type { E2eRunner } from "@/scripts/chain/lib/e2e/runner";
import { acquireDirLock, lockPath, newState } from "@/scripts/chain/lib/e2e/state";
import { assertIgnoredDir, assertSameRoles, e2eTool, writeSummary } from "@/scripts/chain/lib/e2e/tool";
import { expiringDeadline, type World } from "@/scripts/chain/lib/e2e/world";
import { ChainAbortError, ChainRpcError } from "@/scripts/chain/lib/safety";
import { FakeChain, key, tempDir, writeKeypair } from "./helpers/chain-fake";

/** A throwaway git repository as the tool's root (for the check-ignore gates). */
function gitRoot(ignore: string[] = []): string {
  const root = fs.realpathSync(tempDir("e2e-root-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  fs.writeFileSync(path.join(root, ".gitignore"), ignore.map((line) => `${line}\n`).join(""));
  return root;
}

let outputs = 0;
async function run(env: Record<string, string>, root: string) {
  const out = tempDir("e2e-out-");
  const logs: string[] = [];
  const evidence = await runTool(
    "e2e",
    {
      CHAIN_NETWORK: "devnet",
      CHAIN_RPC_URL: "https://rpc.example.test/",
      CHAIN_OUTPUT: path.join(out, `e2e-${++outputs}.json`),
      CHAIN_STATE_DIR: path.join(out, "state"),
      E2E_PAYER: key(7),
      ...env,
    },
    e2eTool,
    { transport: new FakeChain().transport, rps: Infinity, root, home: out, log: (line) => logs.push(line) },
  );
  return { evidence, logs };
}

describe("chain:e2e gates", () => {
  it("a dry run returns awaiting, prints the plan digest and writes nothing into E2E_DIR", async () => {
    const dir = tempDir("e2e-dir-");
    const { evidence, logs } = await run({ E2E_DIR: dir, E2E_GROUPS: "1-3" }, gitRoot());
    expect(evidence.status).toBe("awaiting");
    expect(evidence.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(logs).toContain(`plan digest: ${evidence.planDigest}`);
    expect(logs.some((l) => l.startsWith("dry run: nothing sent") && l.includes(`CHAIN_CONFIRM_PLAN=${evidence.planDigest}`))).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("send mode refuses a CHAIN_CONFIRM_PLAN that is not the digest, before any key is read", async () => {
    const dir = tempDir("e2e-dir-");
    const keys = tempDir("e2e-keys-");
    const payer = writeKeypair(keys, "payer");
    const { evidence } = await run(
      { E2E_DIR: dir, E2E_PAYER: payer.address, E2E_RUN_ID: "abcd12", CHAIN_SEND: "1", CHAIN_KEYPAIR: payer.path, CHAIN_CONFIRM_PLAN: "0".repeat(64) },
      gitRoot(),
    );
    expect(evidence.status).toBe("failed");
    expect(evidence.error).toMatch(/CHAIN_CONFIRM_PLAN does not match/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("refuses a group this version does not implement", async () => {
    const { evidence } = await run({ E2E_DIR: tempDir("e2e-dir-"), E2E_GROUPS: "1-4" }, gitRoot());
    expect(evidence.status).toBe("failed");
    expect(evidence.error).toMatch(/E2E_GROUPS 4 are not implemented yet/);
  });

  it("refuses an E2E_DIR inside the repository unless its files are git-ignored", async () => {
    const root = gitRoot();
    const refused = await run({ E2E_DIR: path.join(root, "e2e") }, root);
    expect(refused.evidence.status).toBe("failed");
    expect(refused.evidence.error).toMatch(/inside the repository and .* not git-ignored/);

    // Ignoring state.json alone is not enough: the keys must be ignored too.
    const partial = gitRoot(["/e2e/state.json"]);
    expect(() => assertIgnoredDir(path.join(partial, "e2e"), partial)).toThrow(/summary.json there is not git-ignored/);

    const ignored = gitRoot(["/e2e/"]);
    const ok = await run({ E2E_DIR: path.join(ignored, "e2e") }, ignored);
    expect(ok.evidence.status).toBe("awaiting");
  });

  it("send mode refuses an E2E_DIR another run holds, and leaves that lock alone", async () => {
    const dir = tempDir("e2e-dir-");
    const root = gitRoot();
    const dry = await run({ E2E_DIR: dir, E2E_RUN_ID: "abcd12" }, root);
    const keys = tempDir("e2e-keys-");
    const payer = writeKeypair(keys, "payer");
    const digest = (await run({ E2E_DIR: dir, E2E_RUN_ID: "abcd12", E2E_PAYER: payer.address }, root)).evidence.planDigest as string;
    expect(digest).not.toBe(dry.evidence.planDigest); // the payer is part of the digest
    fs.writeFileSync(lockPath(dir), `${process.pid}\n`);
    const { evidence } = await run(
      { E2E_DIR: dir, E2E_RUN_ID: "abcd12", E2E_PAYER: payer.address, CHAIN_SEND: "1", CHAIN_KEYPAIR: payer.path, CHAIN_CONFIRM_PLAN: digest },
      root,
    );
    expect(evidence.status).toBe("failed");
    expect(evidence.error).toMatch(/another chain:e2e run holds E2E_DIR/);
    expect(fs.readFileSync(lockPath(dir), "utf8")).toBe(`${process.pid}\n`);
  });
});

describe("E2E_DIR lock", () => {
  it("is exclusive while held and released by its holder", () => {
    const dir = tempDir("e2e-lock-");
    const release = acquireDirLock(dir);
    expect(() => acquireDirLock(dir)).toThrow(/another chain:e2e run holds E2E_DIR \(pid \d+\)/);
    release();
    expect(fs.existsSync(lockPath(dir))).toBe(false);
    acquireDirLock(dir)();
  });

  it("replaces a lock whose pid is gone (a crashed run)", () => {
    const dir = tempDir("e2e-lock-");
    // A pid that is not alive: a finished child process.
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    fs.writeFileSync(lockPath(dir), `${child.stdout}\n`);
    const release = acquireDirLock(dir);
    expect(fs.readFileSync(lockPath(dir), "utf8")).toBe(`${process.pid}\n`);
    release();
  });
});

describe("resume role check", () => {
  it("a role whose key changed since state.json was written stops the run, naming the role", () => {
    const recorded = { funder: key(1), admin: key(2), buyer1: key(3) };
    expect(() => assertSameRoles({}, recorded)).not.toThrow();
    expect(() => assertSameRoles(recorded, { ...recorded })).not.toThrow();
    expect(() => assertSameRoles(recorded, { ...recorded, buyer1: key(4) })).toThrow(/role buyer1 is .* in state.json/);
    expect(() => assertSameRoles(recorded, { funder: key(1), admin: key(2) })).toThrow(/role buyer1 is missing now/);
  });
});

describe("summary", () => {
  it("lists the failed, halted (inflight) and not-run steps", () => {
    const dir = tempDir("e2e-summary-");
    const state = newState({ network: "devnet", genesis: "G", runId: "abcd12" });
    state.steps["1.7"] = { status: "passed", signature: null, actual: null, at: "t" };
    state.steps["1.10"] = { status: "inflight", signature: "5".repeat(88), lastValidBlockHeight: "10", at: "t" };
    state.steps["2.4c"] = { status: "failed", signature: null, actual: null, detail: "expected SaleSoldOut, got ok", at: "t" };
    state.steps["2.7c"] = { status: "skipped", detail: "sale #5 started", at: "t" };
    writeSummary(dir, state, { results: [] } as unknown as E2eRunner, "failed", "devnet", "1.10 could not be resolved");
    const md = fs.readFileSync(path.join(dir, "summary.md"), "utf8");
    expect(md).toContain("## Stopped or not run");
    expect(md).toContain("- run: 1.10 could not be resolved");
    expect(md).toMatch(/- 1\.10: halted inflight — 5{10}… unresolved/);
    expect(md).toContain("- 2.4c: failed — expected SaleSoldOut, got ok");
    expect(md).toContain("- 2.7c: not run — sale #5 started");
    expect(md).not.toContain("- 1.7:");
  });
});

describe("checkpoint wait", () => {
  function fakeClock() {
    let now = 0;
    const slept: number[] = [];
    return { now: () => now, sleep: async (ms: number) => void (slept.push(ms), (now += ms)), slept };
  }

  it("returns true once the check passes, false on timeout", async () => {
    const clock = fakeClock();
    let checks = 0;
    const signal = new AbortController().signal;
    await expect(waitForCheckpoint({ check: async () => ++checks >= 3, waitMs: 60_000, pollMs: 10_000, signal, ...clock })).resolves.toBe(true);
    expect(clock.slept).toEqual([10_000, 10_000, 10_000]);
    const later = fakeClock();
    await expect(waitForCheckpoint({ check: async () => false, waitMs: 30_000, pollMs: 10_000, signal, ...later })).resolves.toBe(false);
    expect(later.slept).toHaveLength(3);
    // No wait configured (E2E_CHECKPOINT_WAIT_MIN=0): no poll at all.
    await expect(waitForCheckpoint({ check: async () => true, waitMs: 0, signal, ...fakeClock() })).resolves.toBe(false);
  });

  it(`retries transient RPC errors with backoff, up to ${CHECKPOINT_MAX_TRANSIENT} in a row`, async () => {
    const clock = fakeClock();
    const signal = new AbortController().signal;
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls <= CHECKPOINT_MAX_TRANSIENT) throw new ChainRpcError("getAccountInfo", 503);
      return true;
    };
    await expect(waitForCheckpoint({ check: flaky, waitMs: 3_600_000, pollMs: 20_000, backoffMs: 1_000, signal, ...clock })).resolves.toBe(true);
    expect(clock.slept).toEqual([20_000, 1_000, 2_000, 4_000, 8_000, 16_000]);

    const down = async () => {
      throw new ChainRpcError("getAccountInfo", 503);
    };
    await expect(waitForCheckpoint({ check: down, waitMs: 3_600_000, signal, ...fakeClock() })).rejects.toBeInstanceOf(ChainRpcError);
    const broken = async () => {
      throw new Error("not transient");
    };
    await expect(waitForCheckpoint({ check: broken, waitMs: 3_600_000, signal, ...fakeClock() })).rejects.toThrow(/not transient/);
  });

  it("an abort is an abort, not a timeout", async () => {
    const controller = new AbortController();
    const clock = fakeClock();
    const check = async () => (controller.abort(), false);
    await expect(waitForCheckpoint({ check, waitMs: 3_600_000, signal: controller.signal, ...clock })).rejects.toBeInstanceOf(ChainAbortError);
  });
});

describe("expiring deadlines (2.5a, 3.4a)", () => {
  function world(chainTime: bigint) {
    const state = newState({ network: "devnet", genesis: "G", runId: "abcd12" });
    const clock = Buffer.alloc(40);
    clock.writeBigInt64LE(chainTime, 32);
    const w = {
      runner: { state, setEntity: (k: string, v: bigint) => void (state.entities[k] = String(v)) },
      rpc: { getAccountInfo: () => ({ send: async () => ({ value: { data: [clock.toString("base64"), "base64"] } }) }) },
    } as unknown as World;
    return { w, state };
  }
  const input = (exists: boolean) => ({ key: "approval3ExpiresAt", step: "2.5a", seconds: BigInt(75), exists: async () => exists });

  it("a value saved by a run whose step never landed is replaced by chain time + the window", async () => {
    const { w, state } = world(BigInt(10_000));
    state.entities.approval3ExpiresAt = "1000";
    await expect(expiringDeadline(w, input(false))).resolves.toBe(BigInt(10_075));
    expect(state.entities.approval3ExpiresAt).toBe("10075");
    state.entities.approval3ExpiresAt = "1000";
    state.steps["2.5a"] = { status: "failed", signature: null, actual: null, detail: "x", at: "t" };
    await expect(expiringDeadline(w, input(false))).resolves.toBe(BigInt(10_075));
  });

  it("is kept while the account may exist: passed, inflight, or on chain", async () => {
    for (const setup of [
      (s: ReturnType<typeof world>["state"]) => (s.steps["2.5a"] = { status: "passed", signature: null, actual: null, at: "t" }),
      (s: ReturnType<typeof world>["state"]) => (s.steps["2.5a"] = { status: "inflight", signature: "5".repeat(88), at: "t" }),
      () => undefined,
    ]) {
      const { w, state } = world(BigInt(10_000));
      state.entities.approval3ExpiresAt = "1000";
      setup(state);
      await expect(expiringDeadline(w, input(state.steps["2.5a"] === undefined))).resolves.toBe(BigInt(1_000));
    }
  });
});
