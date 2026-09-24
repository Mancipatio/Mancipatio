/**
 * Plan, simulation, digest and the send state machine (design-3.3 §3.5, §3.6).
 *
 * build → simulate → journal → send → confirm:
 * - every instruction is built offline before the run and its bytes never
 *   depend on intermediate state;
 * - the plan digest covers the reviewed steps (not the blockhash and not the
 *   compute-budget instructions);
 * - the signed transaction is simulated with `sigVerify:true`, journalled
 *   (fsync) and only then sent with `maxRetries:0`;
 * - a signature is re-broadcast as the identical wire bytes, never rebuilt,
 *   and is declared DROPPED only after the finalized block height passed its
 *   `lastValidBlockHeight` and a history search returns null.
 */
import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Base64EncodedWireTransaction,
  type Blockhash,
  type Instruction,
  type Signature,
  type TransactionSigner,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import type { Journal } from "./journal";
import type { ChainRpc } from "./rpc";
import {
  ChainAbortError,
  ChainPlanError,
  canonicalJson,
  sha256Hex,
  toJson,
} from "./safety";

// ── Plan model ───────────────────────────────────────────────────────────────

export type Precondition<S> = { label: string; holds: (state: S) => boolean };

export type SimulateClass = "now" | "at-send";
export type IdempotencyClass = "replay-safe" | "non-idempotent";
export type Finality = "confirmed" | "finalized";

export type PlanStep<S> = {
  id: string;
  title: string;
  /** Fee payer and the only human-role signer of the transaction. */
  signer: TransactionSigner;
  signerRole: string;
  ixs: Instruction[];
  preconditions: Precondition<S>[];
  simulate: SimulateClass;
  idempotency: IdempotencyClass;
  /** Commitment the step must reach before the next one starts. */
  required: Finality;
  /** True when the step already landed (for example in an earlier run). */
  skip?: (state: S) => boolean;
  postCheck?: (state: S) => boolean;
  /** Shown next to "deferred" in a dry run. */
  dependsOn?: string;
};

const ROLE_NAMES: Record<number, string> = {
  [AccountRole.READONLY]: "r",
  [AccountRole.WRITABLE]: "w",
  [AccountRole.READONLY_SIGNER]: "rs",
  [AccountRole.WRITABLE_SIGNER]: "ws",
};

export type DigestInstruction = {
  program: string;
  accounts: [string, string][];
  dataB64: string;
};

export function instructionView(
  ix: Instruction,
  placeholders: ReadonlyMap<string, string> = new Map(),
): DigestInstruction {
  const ph = (value: string) => placeholders.get(value) ?? value;
  return {
    program: ph(ix.programAddress),
    accounts: (ix.accounts ?? []).map((meta) => [ph(meta.address), ROLE_NAMES[meta.role] ?? String(meta.role)]),
    dataB64: Buffer.from(ix.data ?? new Uint8Array()).toString("base64"),
  };
}

export type DigestInput<S> = {
  network: string;
  genesis: string;
  roleMapSha256: string | null;
  releaseSha256Sums: string | null;
  steps: PlanStep<S>[];
  /** Fresh keypair addresses → stable placeholders (design §3.5). */
  placeholders?: ReadonlyMap<string, string>;
};

export function planDigestPayload<S>(input: DigestInput<S>) {
  return {
    network: input.network,
    genesis: input.genesis,
    roleMapSha256: input.roleMapSha256,
    ...(input.releaseSha256Sums ? { releaseSha256Sums: input.releaseSha256Sums } : {}),
    steps: input.steps.map((step) => ({
      id: step.id,
      preconditions: step.preconditions.map((p) => p.label),
      simulate: step.simulate,
      ixs: step.ixs.map((ix) => instructionView(ix, input.placeholders)),
    })),
  };
}

export function planDigest<S>(input: DigestInput<S>): string {
  return sha256Hex(canonicalJson(planDigestPayload(input)));
}

// ── Transaction building and simulation ──────────────────────────────────────

export const MAX_COMPUTE_UNITS = 1_400_000;

export type LatestBlockhash = { blockhash: Blockhash; lastValidBlockHeight: bigint };

export function buildMessage(input: {
  feePayer: TransactionSigner;
  ixs: Instruction[];
  blockhash: LatestBlockhash;
  cuLimit?: number | null;
  cuPrice?: bigint | null;
}) {
  const budget: Instruction[] = [];
  if (input.cuLimit) budget.push(getSetComputeUnitLimitInstruction({ units: input.cuLimit }));
  if (input.cuPrice && input.cuPrice > BigInt(0)) {
    budget.push(getSetComputeUnitPriceInstruction({ microLamports: input.cuPrice }));
  }
  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(input.feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(input.blockhash, m),
    (m) => appendTransactionMessageInstructions([...budget, ...input.ixs], m),
  );
}

export type SimulationResult = {
  ok: boolean;
  err: unknown;
  logs: string[];
  unitsConsumed: bigint | null;
};

function simulationResult(value: {
  err: unknown;
  logs: readonly string[] | null;
  unitsConsumed?: bigint | null;
}): SimulationResult {
  return {
    ok: value.err === null || value.err === undefined,
    err: value.err ?? null,
    logs: [...(value.logs ?? [])],
    unitsConsumed: value.unitsConsumed ?? null,
  };
}

/** Simulates an unsigned message: noop signers, sigVerify off, fresh blockhash. */
export async function simulateUnsigned(
  rpc: ChainRpc,
  message: ReturnType<typeof buildMessage>,
): Promise<SimulationResult> {
  const wire = getBase64EncodedWireTransaction(compileTransaction(message));
  const { value } = await rpc
    .simulateTransaction(wire, {
      encoding: "base64",
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    })
    .send();
  return simulationResult(value);
}

/** Simulates the exact signed wire bytes with signature verification. */
export async function simulateSigned(
  rpc: ChainRpc,
  wire: Base64EncodedWireTransaction,
): Promise<SimulationResult> {
  const { value } = await rpc
    .simulateTransaction(wire, { encoding: "base64", sigVerify: true, commitment: "confirmed" })
    .send();
  return simulationResult(value);
}

export function summarizeSimulation(result: SimulationResult): string {
  const tail = result.logs.slice(-4).join(" | ");
  return `${toJson(result.err, 0)}${tail ? ` (logs: ${tail})` : ""}`;
}

export function computeUnitLimit(unitsConsumed: bigint | null): number {
  if (unitsConsumed === null) return 200_000;
  return Math.min(MAX_COMPUTE_UNITS, Math.max(5_000, Math.ceil(Number(unitsConsumed) * 1.2)));
}

// ── Send state machine (design §3.6) ───────────────────────────────────────

export type Timing = {
  pollMs: number;
  rebroadcastMs: number;
  finalizeBudgetMs: number;
  /** Consecutive poll failures before the signature is left unresolved. */
  maxPollFailures: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export const DEFAULT_TIMING: Timing = {
  pollMs: 2_000,
  rebroadcastMs: 5_000,
  finalizeBudgetMs: 120_000,
  maxPollFailures: 60,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type TxStatus =
  | "finalized"
  | "confirmed"
  | "landed-unfinalized"
  | "failed"
  | "dropped"
  | "unknown";

export type TxOutcome = { status: TxStatus; signature: Signature; err?: unknown };

type StatusValue = {
  err: unknown;
  confirmationStatus?: "processed" | "confirmed" | "finalized" | null;
} | null;

/**
 * Polls one journalled signature to a resolution. Never rebuilds or re-signs:
 * `rebroadcast` (when given) re-sends the identical wire bytes.
 */
export async function pollSignature(input: {
  rpc: ChainRpc;
  journal: Journal;
  step: string;
  signature: Signature;
  lastValidBlockHeight: bigint;
  required: Finality;
  rebroadcast?: () => Promise<void>;
  signal?: AbortSignal;
  timing?: Partial<Timing>;
  eventName?: "status" | "recover";
}): Promise<TxOutcome> {
  const t = { ...DEFAULT_TIMING, ...input.timing };
  const { rpc, journal, step, signature } = input;
  const eventName = input.eventName ?? "status";
  const record = (status: TxStatus | "landed", extra: Record<string, unknown> = {}) =>
    journal.append({ event: eventName, step, sig: signature, status, ...extra });
  const classify = (value: NonNullable<StatusValue>): TxOutcome | null => {
    if (value.err) {
      record("failed", { err: JSON.parse(toJson(value.err, 0)) });
      return { status: "failed", signature, err: value.err };
    }
    if (value.confirmationStatus === "finalized") {
      record("finalized");
      return { status: "finalized", signature };
    }
    if (input.required === "confirmed" && value.confirmationStatus === "confirmed") {
      record("confirmed");
      return { status: "confirmed", signature };
    }
    return null;
  };
  let landedAt: number | null = null;
  let lastBroadcast = t.now();
  let failures = 0;
  // Block-height and history failures are counted apart: a status call that
  // keeps answering null must not reset them, or the loop never ends.
  let expiryFailures = 0;
  const expiryFailed = (): TxOutcome | null => {
    if (++expiryFailures < t.maxPollFailures) return null;
    record("unknown", { reason: "block height or history polling kept failing" });
    return { status: "unknown", signature };
  };
  for (;;) {
    await t.sleep(t.pollMs);
    let status: StatusValue;
    try {
      status = (await rpc.getSignatureStatuses([signature]).send()).value[0] as StatusValue;
      failures = 0;
    } catch {
      if (++failures >= t.maxPollFailures) {
        record("unknown", { reason: "status polling kept failing" });
        return { status: "unknown", signature };
      }
      continue;
    }
    if (status) {
      const done = classify(status);
      if (done) return done;
      if (landedAt === null) {
        landedAt = t.now();
        record("landed", { confirmationStatus: status.confirmationStatus ?? null });
      }
    }
    if (landedAt !== null) {
      // LANDED: never re-send, never declare dropped; wait for finality.
      if (t.now() - landedAt >= t.finalizeBudgetMs) {
        record("landed-unfinalized");
        return { status: "landed-unfinalized", signature };
      }
      continue;
    }
    let height: bigint;
    try {
      height = await rpc.getBlockHeight({ commitment: "finalized" }).send();
    } catch {
      const gaveUp = expiryFailed();
      if (gaveUp) return gaveUp;
      continue;
    }
    if (height > input.lastValidBlockHeight) {
      let history: StatusValue;
      try {
        history = (
          await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send()
        ).value[0] as StatusValue;
      } catch {
        const gaveUp = expiryFailed();
        if (gaveUp) return gaveUp;
        continue;
      }
      expiryFailures = 0;
      if (history === null) {
        record("dropped", { finalizedBlockHeight: height.toString() });
        return { status: "dropped", signature };
      }
      const done = classify(history);
      if (done) return done;
      landedAt = t.now();
      record("landed", { confirmationStatus: history.confirmationStatus ?? null });
      continue;
    }
    expiryFailures = 0;
    if (input.rebroadcast && !input.signal?.aborted && t.now() - lastBroadcast >= t.rebroadcastMs) {
      lastBroadcast = t.now();
      await input.rebroadcast();
    }
  }
}

/** Journal → send (maxRetries 0) → poll. The journal entry precedes the send. */
export async function submitAndConfirm(input: {
  drainRpc: ChainRpc;
  journal: Journal;
  step: string;
  wire: Base64EncodedWireTransaction;
  signature: Signature;
  lastValidBlockHeight: bigint;
  required: Finality;
  signal?: AbortSignal;
  timing?: Partial<Timing>;
}): Promise<TxOutcome> {
  const { drainRpc, journal, step, wire, signature } = input;
  journal.append({
    event: "signed",
    step,
    sig: signature,
    lastValidBlockHeight: input.lastValidBlockHeight.toString(),
    wireSha256: sha256Hex(Buffer.from(wire, "base64")),
  });
  const send = async () => {
    await drainRpc
      .sendTransaction(wire, {
        encoding: "base64",
        maxRetries: BigInt(0),
        skipPreflight: false,
        preflightCommitment: "confirmed",
      })
      .send();
  };
  try {
    await send();
    journal.append({ event: "sent", step, sig: signature });
  } catch {
    // Do not rebuild: the signature may still land. Go straight to polling.
    journal.append({ event: "sent", step, sig: signature, sendCallFailed: true });
  }
  return pollSignature({
    rpc: drainRpc,
    journal,
    step,
    signature,
    lastValidBlockHeight: input.lastValidBlockHeight,
    required: input.required,
    signal: input.signal,
    timing: input.timing,
    rebroadcast: async () => {
      try {
        await send();
      } catch {
        // A failed rebroadcast changes nothing; the original may still land.
      }
    },
  });
}

// ── Plan executor ────────────────────────────────────────────────────────────

/** A halt that must keep the lock (a signature is still unresolved). */
export class ChainHaltError extends ChainPlanError {
  constructor(message: string) {
    super(message);
    this.name = "ChainHaltError";
  }
}

export type StepRecord = {
  id: string;
  title: string;
  signerRole: string;
  idempotency: IdempotencyClass;
  status: "skipped-landed" | "sent";
  signature?: string;
  outcome?: TxStatus;
  unitsConsumed?: string | null;
  postCheck?: boolean;
};

export type ExecuteContext<S> = {
  rpc: ChainRpc;
  drainRpc: ChainRpc;
  journal: Journal;
  cuPrice: bigint | null;
  probe: () => Promise<S>;
  signal?: AbortSignal;
  timing?: Partial<Timing>;
  log?: (line: string) => void;
  records: StepRecord[];
};

/** Sends the reviewed steps one at a time (only one transaction in flight). */
export async function executePlan<S>(steps: PlanStep<S>[], ctx: ExecuteContext<S>): Promise<void> {
  for (const step of steps) {
    if (ctx.signal?.aborted) throw new ChainAbortError();
    const state = await ctx.probe();
    if (step.skip?.(state)) {
      ctx.records.push({ id: step.id, title: step.title, signerRole: step.signerRole, idempotency: step.idempotency, status: "skipped-landed" });
      ctx.journal.append({ event: "post-check", step: step.id, status: "skipped-landed" });
      ctx.log?.(`skip   ${step.id}: already landed`);
      continue;
    }
    const diverged = step.preconditions.filter((p) => !p.holds(state));
    if (diverged.length) {
      ctx.journal.append({ event: "abort", step: step.id, reason: "state diverged" });
      throw new ChainPlanError(
        `state diverged from reviewed plan at ${step.id}: ${diverged.map((p) => p.label).join("; ")}`,
      );
    }
    const blockhash = (await ctx.rpc.getLatestBlockhash({ commitment: "confirmed" }).send()).value;
    const sizing = await simulateUnsigned(
      ctx.rpc,
      buildMessage({ feePayer: step.signer, ixs: step.ixs, blockhash, cuLimit: MAX_COMPUTE_UNITS, cuPrice: ctx.cuPrice }),
    );
    if (!sizing.ok) {
      ctx.journal.append({ event: "simulated", step: step.id, ok: false });
      throw new ChainPlanError(`simulation failed at ${step.id}: ${summarizeSimulation(sizing)}`);
    }
    const message = buildMessage({
      feePayer: step.signer,
      ixs: step.ixs,
      blockhash,
      cuLimit: computeUnitLimit(sizing.unitsConsumed),
      cuPrice: ctx.cuPrice,
    });
    const signed = await signTransactionMessageWithSigners(message);
    const wire = getBase64EncodedWireTransaction(signed);
    const signature = getSignatureFromTransaction(signed);
    const exact = await simulateSigned(ctx.rpc, wire);
    ctx.journal.append({
      event: "simulated",
      step: step.id,
      ok: exact.ok,
      unitsConsumed: exact.unitsConsumed?.toString() ?? null,
    });
    if (!exact.ok) {
      throw new ChainPlanError(`signed simulation failed at ${step.id}: ${summarizeSimulation(exact)}`);
    }
    if (ctx.signal?.aborted) throw new ChainAbortError();
    ctx.log?.(`send   ${step.id}: ${step.title}`);
    const outcome = await submitAndConfirm({
      drainRpc: ctx.drainRpc,
      journal: ctx.journal,
      step: step.id,
      wire,
      signature,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
      required: step.required,
      signal: ctx.signal,
      timing: ctx.timing,
    });
    const record: StepRecord = {
      id: step.id,
      title: step.title,
      signerRole: step.signerRole,
      idempotency: step.idempotency,
      status: "sent",
      signature,
      outcome: outcome.status,
      unitsConsumed: exact.unitsConsumed?.toString() ?? null,
    };
    ctx.records.push(record);
    if (outcome.status === "failed") {
      throw new ChainPlanError(`${step.id} failed on-chain: ${toJson(outcome.err, 0)}`);
    }
    if (outcome.status === "dropped") {
      throw new ChainPlanError(`${step.id} expired without landing; re-run the dry run to re-plan`);
    }
    if (outcome.status === "landed-unfinalized" || outcome.status === "unknown") {
      throw new ChainHaltError(
        `${step.id} ${outcome.status === "unknown" ? "could not be resolved" : "landed but did not finalize in time"}; never re-send it. Resolve with CHAIN_RECOVER=1`,
      );
    }
    if (step.postCheck) {
      const after = await ctx.probe();
      record.postCheck = step.postCheck(after);
      ctx.journal.append({ event: "post-check", step: step.id, ok: record.postCheck });
      if (!record.postCheck) throw new ChainPlanError(`post-check failed after ${step.id}`);
    }
    ctx.log?.(`done   ${step.id} (${outcome.status})`);
  }
}
