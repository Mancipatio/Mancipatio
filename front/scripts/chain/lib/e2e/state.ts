/**
 * `<E2E_DIR>/state.json` (design-6.3 §E): what a resumed run needs — the run
 * id, the network it belongs to, derived entity addresses, and every step's
 * outcome. Written atomically (tmp + rename, mode 600) after every change.
 *
 * A step is recorded `inflight` with its signature BEFORE the send, so a
 * crash between send and record can never make a resumed run repeat a
 * non-idempotent step (a buy, a deposit): the next run resolves the
 * signature first.
 */
import fs from "node:fs";
import path from "node:path";
import { ChainGateError } from "../safety";
import type { ChainFailure } from "./errors";

export const E2E_STATE_SCHEMA = "mancipatio-e2e-state-v1";

export type StepState =
  | { status: "inflight"; signature: string; at: string }
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
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function entity(state: E2eState, key: string): string {
  const value = state.entities[key];
  if (value === undefined) throw new ChainGateError(`e2e state has no ${key} yet; run the earlier groups first`);
  return value;
}
