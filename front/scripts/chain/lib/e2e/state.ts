/**
 * `<E2E_DIR>/state.json` (design-6.3 §E): what a resumed run needs — the run
 * id, the network it belongs to, derived entity addresses, and every step's
 * outcome. Written atomically (tmp + rename, mode 600) after every change.
 *
 * A step is recorded `inflight` with its signature BEFORE the send, so a
 * crash between send and record can never make a resumed run repeat a
 * non-idempotent step (a buy, a deposit): the next run resolves the
 * signature first. One run per directory (acquireDirLock).
 */
import fs from "node:fs";
import path from "node:path";
import { ChainGateError } from "../safety";
import type { ChainFailure } from "./errors";

export const E2E_STATE_SCHEMA = "mancipatio-e2e-state-v1";

export type StepState =
  // lastValidBlockHeight (decimal): a resumed run may call an unseen
  // signature dropped only once the finalized block height is past it.
  | { status: "inflight"; signature: string; lastValidBlockHeight?: string; at: string }
  // Not run because the chain's clock moved past what the step shows; never
  // counts as passed, never fails the run.
  | { status: "skipped"; detail: string; at: string }
  | { status: "passed"; signature: string | null; actual: ChainFailure | null; at: string }
  | { status: "failed"; signature: string | null; actual: ChainFailure | null; detail: string; at: string };

export type E2eState = {
  schema: typeof E2E_STATE_SCHEMA;
  network: string;
  genesis: string;
  runId: string;
  createdUtc: string;
  /** Role → address (addresses only). */
  roles: Record<string, string>;
  /** Derived entities: PDAs, ids and timestamps the later steps reuse. */
  entities: Record<string, string>;
  steps: Record<string, StepState>;
};

export function statePath(dir: string): string {
  return path.join(dir, "state.json");
}

export function newState(input: { network: string; genesis: string; runId: string }): E2eState {
  return {
    schema: E2E_STATE_SCHEMA,
    network: input.network,
    genesis: input.genesis,
    runId: input.runId,
    createdUtc: new Date().toISOString(),
    roles: {},
    entities: {},
    steps: {},
  };
}

export function loadState(dir: string): E2eState | null {
  const file = statePath(dir);
  if (!fs.existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new ChainGateError("state.json is not valid JSON; inspect it before resuming");
  }
  const state = parsed as Partial<E2eState>;
  if (state.schema !== E2E_STATE_SCHEMA || typeof state.runId !== "string" || !state.steps || !state.entities || !state.roles) {
    throw new ChainGateError("state.json has an unexpected shape; inspect it before resuming");
  }
  return state as E2eState;
}

/** Refuses a state that belongs to another network, genesis or run. */
export function assertStateMatches(state: E2eState, expected: { network: string; genesis: string; runId: string | null }): void {
  if (state.network !== expected.network || state.genesis !== expected.genesis) {
    throw new ChainGateError(
      `state.json belongs to ${state.network} (genesis ${state.genesis.slice(0, 8)}…); use another E2E_DIR for this network`,
    );
  }
  if (expected.runId !== null && expected.runId !== state.runId) {
    throw new ChainGateError(`E2E_RUN_ID ${expected.runId} differs from the run ${state.runId} recorded in state.json`);
  }
}

export function saveState(dir: string, state: E2eState): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = statePath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  // fsync before the rename and the directory after it: an inflight record
  // must survive a power loss, or a resumed run could send a buy twice.
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    const dirFd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // best effort: some platforms refuse fsync on a directory
  }
}

export function lockPath(dir: string): string {
  return path.join(dir, "e2e.lock");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * One run per E2E_DIR: an exclusive lock file (`wx`, holding the pid) taken
 * before state.json is read for sending. A lock whose pid is gone is stale
 * (a crashed run) and replaced once. Returns the release function.
 */
export function acquireDirLock(dir: string): () => void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = lockPath(dir);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(file, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
      const valid = Number.isInteger(pid) && pid > 0;
      // No pid yet may be a lock being written this instant: stale only when old.
      const held = valid ? pidAlive(pid) : Date.now() - fs.statSync(file).mtimeMs < 10_000;
      if (attempt > 0 || held) {
        throw new ChainGateError(`another chain:e2e run holds E2E_DIR (pid ${valid ? pid : "?"}); wait for it or remove e2e.lock if it is gone`);
      }
      fs.rmSync(file, { force: true });
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fs.rmSync(file, { force: true });
  };
}

export function entity(state: E2eState, key: string): string {
  const value = state.entities[key];
  if (value === undefined) throw new ChainGateError(`e2e state has no ${key} yet; run the earlier groups first`);
  return value;
}
