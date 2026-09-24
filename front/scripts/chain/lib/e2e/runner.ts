/**
 * Runs one e2e matrix step = one transaction (design-6.3 §E), on top of the
 * reviewed send path in ../tx.ts:
 *
 * - resume: a passed step is skipped; an inflight one is resolved from its
 *   signature before anything else; a positive step whose effect the chain
 *   already shows (`done`) is recorded without sending;
 * - every transaction is signed and simulated with `sigVerify:true`;
 * - a positive step is sent (journalled first, maxRetries 0) and must reach
 *   `finalized` — the app builders read finalized state;
 * - a negative step is never sent: its signed simulation must fail in the
 *   expected program with the expected code.
 *
 * A mismatch stops the run with a public message; state.json and the
 * journal keep the evidence.
 */
import {
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  signTransactionMessageWithSigners,
  type Instruction,
  type Signature,
  type TransactionSigner,
} from "@solana/kit";
import type { Journal } from "../journal";
import type { ChainRpc } from "../rpc";
import { ChainAbortError, ChainGateError, ChainPlanError, toJson } from "../safety";
import {
  ChainHaltError,
  MAX_COMPUTE_UNITS,
  buildMessage,
  computeUnitLimit,
  simulateSigned,
  submitAndConfirm,
  type Timing,
} from "../tx";
import { classifyFailure, describeFailure, matchesExpectation, type ChainFailure } from "./errors";
import { stepSpec, type E2eNetwork, type StepSpec } from "./matrix";
import { saveState, type E2eState } from "./state";

export type TxBuild = { payer: TransactionSigner; ixs: Instruction[] };

export type StepResult = "passed" | "skipped" | "not-applicable";

export type RunnerOptions = {
  network: E2eNetwork;
  groups: readonly number[];
  dir: string;
  state: E2eState;
  rpc: ChainRpc;
  drainRpc: ChainRpc;
  journal: Journal;
  cuPrice: bigint | null;
  signal: AbortSignal;
  timing?: Partial<Timing>;
  log: (line: string) => void;
  /** RPC calls made so far (the tool's request budget). */
  requestCount: () => number;
  maxRequests: number;
};

export type StepOptions = {
  /** A positive step whose effect is already on chain (an earlier run landed it). */
  done?: () => Promise<boolean>;
};

export class E2eRunner {
  readonly results: { id: string; title: string; outcome: string; actual: string; signature: string | null }[] = [];

  constructor(private readonly o: RunnerOptions) {}

  get state(): E2eState {
    return this.o.state;
  }

  applies(id: string): boolean {
    const spec = stepSpec(id);
    return spec.networks.includes(this.o.network) && this.o.groups.includes(spec.group);
  }

  setEntity(key: string, value: string | bigint | number): void {
    this.o.state.entities[key] = String(value);
    saveState(this.o.dir, this.o.state);
  }

  private record(spec: StepSpec, value: E2eState["steps"][string]): void {
    this.o.state.steps[spec.id] = value;
    saveState(this.o.dir, this.o.state);
  }

  private checkBudget(): void {
    if (this.o.signal.aborted) throw new ChainAbortError();
    if (this.o.requestCount() > this.o.maxRequests) {
      throw new ChainGateError(`E2E_MAX_REQUESTS (${this.o.maxRequests}) reached; resume in a new run`);
    }
  }

  private pushResult(spec: StepSpec, outcome: string, actual: ChainFailure | null, signature: string | null): void {
    this.results.push({ id: spec.id, title: spec.title, outcome, actual: describeFailure(actual), signature });
    this.o.journal.append({ event: "e2e-result", step: spec.id, outcome, actual, sig: signature ?? undefined });
  }

  /** Resolves a signature an earlier run left inflight: true when it landed ok. */
  private async resolveInflight(spec: StepSpec, signature: string): Promise<boolean> {
    const status = (
      await this.o.rpc.getSignatureStatuses([signature as Signature], { searchTransactionHistory: true }).send()
    ).value[0];
    if (!status) return false; // never landed (its lock was resolved as dropped): send again
    if (status.err) {
      const actual = classifyFailure(status.err, []);
      this.record(spec, { status: "failed", signature, actual, detail: "landed with an error in an earlier run", at: new Date().toISOString() });
      throw new ChainPlanError(`${spec.id} landed with an error in an earlier run: ${toJson(status.err, 0)}`);
    }
    if (status.confirmationStatus !== "finalized") {
      throw new ChainHaltError(`${spec.id} from an earlier run is not finalized yet; wait and re-run`);
    }
    this.record(spec, { status: "passed", signature, actual: null, at: new Date().toISOString() });
    return true;
  }

  /** True when an earlier run recorded the step as passed. */
  passed(id: string): boolean {
    return this.o.state.steps[id]?.status === "passed";
  }

  /**
   * Records a step that is not one transaction of ours: the bootstrap plan's
   * cycles (0.2) or the Super Admin's browser signature at a checkpoint (1.3).
   */
  markPassed(id: string, detail: string, signature: string | null = null): void {
    const spec = stepSpec(id);
    this.record(spec, { status: "passed", signature, actual: null, at: new Date().toISOString() });
    this.o.journal.append({ event: "e2e-result", step: id, outcome: "passed", detail });
    this.results.push({ id, title: spec.title, outcome: detail, actual: "ok", signature });
    this.o.log(`pass   ${id}: ${detail}`);
  }

  async step(id: string, build: () => Promise<TxBuild>, options: StepOptions = {}): Promise<StepResult> {
    const spec = stepSpec(id);
    if (!this.applies(id)) return "not-applicable";
    this.checkBudget();
    const prior = this.o.state.steps[id];
    if (prior?.status === "passed") {
      this.o.log(`skip   ${id}: passed in an earlier run`);
      this.results.push({ id, title: spec.title, outcome: "passed-earlier", actual: describeFailure(prior.actual), signature: prior.signature });
      return "skipped";
    }
    if (prior?.status === "inflight" && (await this.resolveInflight(spec, prior.signature))) {
      this.o.log(`skip   ${id}: landed in an earlier run`);
      this.pushResult(spec, "passed-earlier", null, prior.signature);
      return "skipped";
    }
    if (spec.expect.ok && options.done && (await options.done())) {
      this.record(spec, { status: "passed", signature: null, actual: null, at: new Date().toISOString() });
      this.o.log(`skip   ${id}: already on chain`);
      this.pushResult(spec, "already-on-chain", null, null);
      return "skipped";
    }

    this.o.journal.append({ event: "e2e-step", step: id, group: spec.group, title: spec.title, signerRole: spec.signer, expect: spec.expect });
    const { payer, ixs } = await build();
    const sign = async (cuLimit: number) => {
      const blockhash = (await this.o.rpc.getLatestBlockhash({ commitment: "confirmed" }).send()).value;
      const message = buildMessage({ feePayer: payer, ixs, blockhash, cuLimit, cuPrice: this.o.cuPrice });
      const signed = await signTransactionMessageWithSigners(message);
      return {
        wire: getBase64EncodedWireTransaction(signed),
        signature: getSignatureFromTransaction(signed),
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
      };
    };

    const probe = await sign(MAX_COMPUTE_UNITS);
    const simulation = await simulateSigned(this.o.rpc, probe.wire);
    const failure = simulation.ok ? null : classifyFailure(simulation.err, simulation.logs);
    this.o.journal.append({
      event: "simulated",
      step: id,
      ok: simulation.ok,
      unitsConsumed: simulation.unitsConsumed?.toString() ?? null,
      actual: failure,
      logs: simulation.ok ? undefined : simulation.logs.slice(-8),
    });

    if (!spec.expect.ok) {
      if (matchesExpectation(spec.expect, failure)) {
        this.record(spec, { status: "passed", signature: null, actual: failure, at: new Date().toISOString() });
        this.o.log(`pass   ${id}: refused as expected — ${describeFailure(failure)}`);
        this.pushResult(spec, "refused-as-expected", failure, null);
        return "passed";
      }
      const detail = `expected ${spec.expect.program} ${spec.expect.name} (${spec.expect.code}), got ${describeFailure(failure)}`;
      this.record(spec, { status: "failed", signature: null, actual: failure, detail, at: new Date().toISOString() });
      this.pushResult(spec, "mismatch", failure, null);
      throw new ChainPlanError(`${id} ${spec.title}: ${detail}`);
    }

    if (!simulation.ok) {
      const detail = `expected success, simulation failed: ${describeFailure(failure)}; logs: ${simulation.logs.slice(-4).join(" | ")}`;
      this.record(spec, { status: "failed", signature: null, actual: failure, detail, at: new Date().toISOString() });
      this.pushResult(spec, "mismatch", failure, null);
      throw new ChainPlanError(`${id} ${spec.title}: ${detail}`);
    }

    this.checkBudget();
    const tx = await sign(computeUnitLimit(simulation.unitsConsumed));
    this.record(spec, { status: "inflight", signature: tx.signature, at: new Date().toISOString() });
    this.o.log(`send   ${id}: ${spec.title}`);
    const outcome = await submitAndConfirm({
      drainRpc: this.o.drainRpc,
      journal: this.o.journal,
      step: id,
      wire: tx.wire,
      signature: tx.signature,
      lastValidBlockHeight: tx.lastValidBlockHeight,
      required: "finalized",
      signal: this.o.signal,
      timing: this.o.timing,
    });
    if (outcome.status === "finalized") {
      this.record(spec, { status: "passed", signature: tx.signature, actual: null, at: new Date().toISOString() });
      this.o.log(`done   ${id} (${tx.signature.slice(0, 12)}…)`);
      this.pushResult(spec, "landed", null, tx.signature);
      return "passed";
    }
    if (outcome.status === "failed") {
      const actual = classifyFailure(outcome.err, []);
      this.record(spec, { status: "failed", signature: tx.signature, actual, detail: "failed on-chain", at: new Date().toISOString() });
      this.pushResult(spec, "failed-on-chain", actual, tx.signature);
      throw new ChainPlanError(`${id} failed on-chain: ${toJson(outcome.err, 0)}`);
    }
    if (outcome.status === "dropped") {
      // Never landed: the next run may send it again.
      delete this.o.state.steps[id];
      saveState(this.o.dir, this.o.state);
      throw new ChainPlanError(`${id} expired without landing; re-run to send it again`);
    }
    throw new ChainHaltError(
      `${id} ${outcome.status === "unknown" ? "could not be resolved" : "landed but did not finalize in time"}; never re-send it. Resolve with CHAIN_RECOVER=1, then re-run`,
    );
  }
}
