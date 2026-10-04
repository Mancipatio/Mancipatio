// The simulation gate: run the exact transaction against the network before
// a wallet is asked to sign it, and refuse with an explained error when it
// would fail.
//
// Why: `@solana/client`'s compute-unit estimate simulates the transaction but
// ignores the simulation's `err` (it only keeps `unitsConsumed`), so before
// this gate a transaction that was certain to fail still reached the wallet,
// and only the wallet's own preview stood between the user and a failed,
// fee-paying send. lib/verified-solana-client calls simulateMessage once per
// send (sigVerify off, the blockhash replaced by the node) and reuses the
// same answer for the compute-unit limit, so a send costs no extra RPC call.
//
// Pure and node-safe (no "use client", no React, no browser API): the panel's
// "test run", the devnet rehearsal script and the tests use it directly.
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type GetSignatureStatusesApi,
  type Instruction,
  type Rpc,
  type Signature,
  type SimulateTransactionApi,
} from "@solana/kit";
import { MAX_COMPUTE_UNIT_LIMIT, setComputeUnitLimitInstruction } from "@/lib/compute-budget";
import { withRpcReadRetry, type RpcReadRetryOptions } from "@/lib/rpc-retry";
import {
  AssetRegistryInstruction,
  identifyAssetRegistryInstruction,
} from "@/lib/generated/asset_registry/programs";
import {
  TransferHookInstruction,
  identifyTransferHookInstruction,
} from "@/lib/generated/transfer_hook/programs";
import {
  classifyFailure,
  contextualErrorHint,
  customErrorName,
  describeProgram,
  failedInstructionIndex,
  instructionErrorText,
  knownProgram,
  programErrorHint,
  transactionErrorText,
} from "@/lib/program-errors";

// ── One simulation ───────────────────────────────────────────────────────────

/** A message ready to compile: fee payer and lifetime set (what `prepare` returns). */
export type SimulatableMessage = Parameters<typeof compileTransaction>[0];

export type SimulationRpc = Rpc<SimulateTransactionApi>;

export type SimulationVerdict = {
  /** The TransactionError, or null when the transaction would succeed. */
  err: unknown;
  logs: string[];
  unitsConsumed: number | null;
};

/**
 * A lifetime for a message that is only simulated: the node replaces the
 * blockhash (`replaceRecentBlockhash`), so preparing a probe needs no
 * getLatestBlockhash round trip.
 */
export const PROBE_LIFETIME = Object.freeze({
  blockhash: "11111111111111111111111111111111" as Blockhash,
  lastValidBlockHeight: BigInt(0),
});

/**
 * ONE simulateTransaction of the exact message: signatures are not checked
 * (the wallet has not signed yet) and the node supplies a current blockhash,
 * at `confirmed` like the send's preflight. RPC failures throw; the caller
 * decides (the verified client fails closed).
 */
export async function simulateMessage(rpc: SimulationRpc, message: SimulatableMessage): Promise<SimulationVerdict> {
  const wire = getBase64EncodedWireTransaction(compileTransaction(message));
  const { value } = await rpc
    .simulateTransaction(wire, {
      encoding: "base64",
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    })
    .send();
  const units = value.unitsConsumed;
  return {
    err: value.err ?? null,
    logs: [...(value.logs ?? [])],
    unitsConsumed: units === undefined || units === null ? null : Number(units),
  };
}

/**
 * The compute-unit limit `@solana/client`'s prepareTransaction would set from
 * this estimate (1.7.0): ceil(units × multiplier), at least 200k, at most the
 * 1.4M ceiling; no estimate gives 200k. `headroom` (default 0) is added to
 * ceil(units × multiplier) before the floor and the ceiling: Send to wallets
 * passes DISTRIBUTION_GUARD_HEADROOM_UNITS (lib/wallet-changes), room for the
 * guards a wallet adds after the simulation.
 */
export function computeUnitLimitFromSimulation(unitsConsumed: number | null, multiplier = 1.1, headroom = 0): number {
  const floor = 200_000;
  if (!unitsConsumed) return floor;
  return Math.min(MAX_COMPUTE_UNIT_LIMIT, Math.max(floor, Math.ceil(unitsConsumed * multiplier) + headroom));
}

/**
 * Simulates bare instructions for a preflight shown on screen (the panel's
 * "Test run on the network") or a script: `feePayer` pays, no signature is
 * needed, the blockhash is the node's and the limit is the 1.4M ceiling, as
 * the verified client simulates a send. Returns the verdict and, when the
 * transaction would fail, the refusal the send would raise.
 */
export async function simulateInstructions(
  rpc: SimulationRpc,
  input: { feePayer: Address; instructions: readonly Instruction[]; network?: string; issuerRotation?: boolean },
): Promise<{ verdict: SimulationVerdict; refusal: SimulationRefusedError | null }> {
  const limit = setComputeUnitLimitInstruction(MAX_COMPUTE_UNIT_LIMIT);
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(input.feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(PROBE_LIFETIME, m),
    (m) => appendTransactionMessageInstructions([limit, ...input.instructions], m),
  );
  const verdict = await simulateMessage(rpc, message);
  return {
    verdict,
    refusal: refusalFromSimulation(verdict, {
      appInstructions: input.instructions,
      messageInstructionCount: input.instructions.length + 1,
      network: input.network,
      issuerRotation: input.issuerRotation,
    }),
  };
}

// ── The refusal ──────────────────────────────────────────────────────────────

/** What a step of the transaction does, by its program and, for ours, its instruction. */
export function describeInstruction(ix: { programAddress: string; data?: ArrayLike<number> }): string {
  const program = knownProgram(ix.programAddress);
  const data = ix.data ? Uint8Array.from(Array.from({ length: ix.data.length }, (_, i) => ix.data![i])) : new Uint8Array();
  try {
    if (program === "asset_registry") return words(AssetRegistryInstruction[identifyAssetRegistryInstruction(data)]);
    if (program === "transfer_hook") return words(TransferHookInstruction[identifyTransferHookInstruction(data)]);
  } catch {
    // An instruction the generated SDK does not know: name the program only.
  }
  switch (program) {
    case "token_2022":
      // TransferChecked (12) is the only Token-2022 instruction the app sends on its own.
      return data[0] === 12 ? "token transfer" : "Token-2022 instruction";
    case "associated_token":
      return "token account creation";
    case "system":
      return data[0] === 2 ? "SOL transfer" : "System instruction";
    case "compute_budget":
      return "compute budget";
    case "asset_registry":
      return "Manci registry instruction";
    case "transfer_hook":
      return "Manci transfer-hook instruction";
    default:
      return `instruction of ${describeProgram(ix.programAddress)}`;
  }
}

/** "MintToTreasury" → "mint to treasury". */
function words(pascal: string | undefined): string {
  if (!pascal) return "instruction";
  return pascal.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

const OPENING = "This transaction would fail, so your wallet was not opened.";

/**
 * A send the network would refuse, found by simulating it before the wallet
 * opened. `message` is the whole explanation; `detail` drops the opening
 * sentence (for a list row). `instructionIndex` counts the app's own
 * instructions (the compute-budget instructions the send path puts in front
 * are not counted); null when the failure is not one instruction's.
 */
export class SimulationRefusedError extends Error {
  readonly detail: string;
  /** The refusal in plain words, without where it happened ("Step N of M …"): a distribution row's reason. */
  readonly reason: string;
  readonly instructionIndex: number | null;
  readonly instructionCount: number;
  readonly program: string | null;
  readonly code: number | null;
  readonly errorName: string | null;
  readonly logs: readonly string[];
  readonly err: unknown;
  constructor(fields: {
    detail: string;
    reason?: string;
    instructionIndex: number | null;
    instructionCount: number;
    program: string | null;
    code: number | null;
    errorName: string | null;
    logs: readonly string[];
    err: unknown;
  }) {
    super(`${OPENING} ${fields.detail}`);
    this.name = "SimulationRefusedError";
    this.detail = fields.detail;
    this.reason = fields.reason ?? fields.detail;
    this.instructionIndex = fields.instructionIndex;
    this.instructionCount = fields.instructionCount;
    this.program = fields.program;
    this.code = fields.code;
    this.errorName = fields.errorName;
    this.logs = fields.logs;
    this.err = fields.err;
  }
}

/** The network could not be asked: nothing was sent (the gate fails closed). */
export class SimulationUnavailableError extends Error {
  constructor(network: string, cause: unknown) {
    const reason = cause instanceof Error && cause.message ? ` (${cause.message})` : "";
    super(`Could not test this transaction on ${network} before opening your wallet, so nothing was sent${reason}. Try again in a moment.`, { cause });
    this.name = "SimulationUnavailableError";
  }
}

/** A sentence ends in one full stop; the hint tables mostly carry none. */
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/**
 * The refusal for a failed simulation, or null when it succeeded.
 * `appInstructions` are the instructions the app built; the message may carry
 * `messageInstructionCount - appInstructions.length` compute-budget
 * instructions in front of them (the SDK's prefix), which the step number
 * leaves out. A code the failing program's table does not word (the
 * registry's 6000 / 6001, Anchor's 3012 / 2006) is explained from the
 * account and error Anchor names in the logs (contextualErrorHint, the
 * wording lib/tx-error gives after a failed preflight); `issuerRotation`
 * (lib/features, passed in so this module stays free of it) adds the sale
 * sync to a sale's Unauthorized.
 */
export function refusalFromSimulation(
  verdict: SimulationVerdict,
  context: {
    appInstructions: readonly { programAddress: string; data?: ArrayLike<number> }[];
    messageInstructionCount?: number;
    network?: string;
    issuerRotation?: boolean;
  },
): SimulationRefusedError | null {
  if (verdict.err === null || verdict.err === undefined) return null;
  const network = context.network ?? "the network";
  const count = context.appInstructions.length;
  const prefix = Math.max(0, (context.messageInstructionCount ?? count) - count);
  const messageIndex = failedInstructionIndex(verdict.err);
  const appIndex = messageIndex === null ? null : messageIndex - prefix;
  const failure = classifyFailure(verdict.err, verdict.logs);

  // The failing program: the innermost `failed` line; without logs, the
  // instruction's own program. A Token-2022 transfer that fails with a
  // custom code in the hook's range and no logs is the hook's refusal (the
  // only program Token-2022 calls into for a share-class mint).
  let program = failure.program;
  const ix = appIndex !== null && appIndex >= 0 && appIndex < count ? context.appInstructions[appIndex] : null;
  if (!program && ix) {
    program = ix.programAddress;
    if (knownProgram(program) === "token_2022" && failure.code !== null && failure.code >= 6000 && failure.code <= 6100) {
      program = "transfer_hook";
    }
  }
  const label = knownProgram(program) ?? program;
  const name = failure.code !== null ? (failure.name ?? customErrorName(label, failure.code)) : failure.name;

  let reason: string;
  let plain: string;
  if (messageIndex === null) {
    // The whole transaction was refused before any instruction ran.
    reason = (name && transactionErrorText(name, network)) ?? `The network refused it before running it (${name ?? "unknown error"}).`;
    plain = reason;
  } else {
    const hint =
      (failure.code !== null ? programErrorHint({ program: label, code: failure.code }) : name ? instructionErrorText(name) : null) ??
      contextualErrorHint(verdict.logs.join("\n"), { issuerRotation: () => context.issuerRotation === true });
    const tag = failure.code !== null ? `${name ?? "custom error"}, ${failure.code}` : (name ?? "error");
    const explained = hint ? (name && hint.includes(`(${name})`) ? hint : `${sentence(hint).slice(0, -1)} (${tag}).`) : `It failed with ${tag}.`;
    const where =
      appIndex === null || appIndex < 0
        ? "The compute-budget setup"
        : ix
          ? `Step ${appIndex + 1} of ${count} (${describeInstruction(ix)})`
          : `Instruction ${messageIndex + 1}`;
    reason = `${where} was refused by ${describeProgram(program)}: ${explained}`;
    plain = explained;
  }
  return new SimulationRefusedError({
    detail: sentence(reason),
    reason: sentence(plain),
    instructionIndex: ix ? appIndex : null,
    instructionCount: count,
    program: label,
    code: failure.code,
    errorName: name,
    logs: verdict.logs,
    err: verdict.err,
  });
}

// ── Waiting for a send to land ───────────────────────────────────────────────

export type SignatureOutcome = "confirmed" | "failed" | "timeout" | "unknown";

/** How waitForSignature and waitForSignatures poll. */
export type SignatureWaitOptions = {
  /** How long to wait in all (default 30 s). */
  timeoutMs?: number;
  /** Between two reads (default 0.5 s). */
  pollMs?: number;
  isCancelled?: () => boolean;
  /**
   * Retry a status read the RPC refused for a moment (HTTP 429, a 5xx, no
   * response: lib/rpc-retry withRpcReadRetry, at most its retries per read)
   * instead of answering "unknown" at once. Bounded by the timeout: no retry
   * or wait starts after it, so the whole wait stays within `timeoutMs` (plus
   * the read in flight). `true` takes the default waits; tests pass their own.
   */
  retryReads?: boolean | Pick<RpcReadRetryOptions, "delaysMs" | "sleep" | "random">;
};

/**
 * Polls one signature until it is confirmed (or finalized), failed, the
 * timeout passes, or the status cannot be read ("unknown": the caller goes on
 * and lets the next simulation decide).
 */
export async function waitForSignature(
  rpc: Rpc<GetSignatureStatusesApi>,
  signature: string,
  options: SignatureWaitOptions = {},
): Promise<SignatureOutcome> {
  return (await waitForSignatures(rpc, [signature], options))[0];
}

type ReadStatus = { err: unknown; confirmationStatus?: string | null } | null | undefined;

/**
 * waitForSignature for several signatures at once, in one
 * getSignatureStatuses call per poll (never one call per signature): each
 * outcome is decided when its transaction is confirmed or failed; the rest
 * are "timeout" once the timeout passes, or "unknown" when a read fails (after
 * the retries `retryReads` allows) or `isCancelled` says so. In order.
 */
export async function waitForSignatures(
  rpc: Rpc<GetSignatureStatusesApi>,
  signatures: readonly string[],
  options: SignatureWaitOptions = {},
): Promise<SignatureOutcome[]> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  const outcomes: (SignatureOutcome | null)[] = signatures.map(() => null);
  const rest = (outcome: SignatureOutcome) => outcomes.map((o) => o ?? outcome);
  const retry = options.retryReads ? (options.retryReads === true ? {} : options.retryReads) : null;
  // The retries end with the timeout: no further read or wait starts after it.
  const stop = retry ? new AbortController() : null;
  const timer = stop ? setTimeout(() => stop.abort(), timeoutMs) : null;
  try {
    for (;;) {
      const open = outcomes.flatMap((o, i) => (o === null ? [i] : []));
      if (open.length === 0) return outcomes as SignatureOutcome[];
      // The read itself is never cut off: an answer in flight at the timeout still counts.
      const read = async (): Promise<readonly ReadStatus[]> =>
        (await rpc.getSignatureStatuses(open.map((i) => signatures[i] as Signature)).send()).value;
      let value: readonly ReadStatus[];
      try {
        value = retry && stop ? await withRpcReadRetry(read, { ...retry, signal: stop.signal }) : await read();
      } catch {
        return rest("unknown");
      }
      open.forEach((i, k) => {
        const status = value[k];
        if (status?.err) outcomes[i] = "failed";
        else if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") outcomes[i] = "confirmed";
      });
      if (outcomes.every((o) => o !== null)) return outcomes as SignatureOutcome[];
      if (options.isCancelled?.()) return rest("unknown");
      if (Date.now() + pollMs > deadline) return rest("timeout");
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}
