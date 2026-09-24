/**
 * Runner harness shared by the four chain tools (design-3.3 §3.7, §3.8):
 * config → abort controller (deadline, SIGINT, SIGTERM) → fetch guard →
 * guarded RPC → tool body → evidence written in `finally` (also on abort),
 * lock kept while any journalled signature is unresolved.
 */
import fs from "node:fs";
import path from "node:path";
import type { RpcTransport } from "@solana/kit";
import {
  Journal,
  acquireLock,
  lockPath,
  readJournal,
  readLock,
  releaseLock,
  unresolvedSignatures,
  type HeldLock,
} from "./journal";
import { createChainRpc, type ChainRpc } from "./rpc";
import {
  ChainAbortError,
  ChainGateError,
  FRONT_DIR,
  assertOutputPath,
  gitHead,
  installFetchGuard,
  publicErrorMessage,
  readChainConfig,
  repoRoot,
  toJson,
  type ChainConfig,
  type ChainEnv,
  type ChainTool,
} from "./safety";
import { pollSignature, type Timing } from "./tx";

export type ToolStatus = "completed" | "awaiting" | "aborted" | "failed";

export type ToolDeps = {
  /** Injected RPC transport (tests); defaults to kit's HTTP transport. */
  transport?: RpcTransport;
  timing?: Partial<Timing>;
  /** RPC throttle override (tests pass Infinity). */
  rps?: number;
  retryDelayMs?: number;
  root?: string;
  frontDir?: string;
  home?: string;
  log?: (line: string) => void;
  /** Install SIGINT/SIGTERM handlers (runners: true; tests: false). */
  signalHandlers?: boolean;
  /** Pre-aborted or externally controlled signal (tests). */
  signal?: AbortSignal;
};

export type ToolContext = {
  tool: ChainTool;
  env: ChainEnv;
  config: ChainConfig;
  deps: ToolDeps;
  rpc: ChainRpc;
  drainRpc: ChainRpc;
  signal: AbortSignal;
  root: string;
  frontDir: string;
  evidence: Record<string, unknown>;
  phase: string;
  log: (line: string) => void;
  journal: Journal | null;
  lock: HeldLock | null;
  timing?: Partial<Timing>;
  /** Opens `<CHAIN_OUTPUT>.journal.jsonl` and takes the network lock. */
  beginSend: () => Journal;
};

export type ToolBody = (ctx: ToolContext) => Promise<ToolStatus>;

export function journalPathFor(output: string): string {
  return `${output}.journal.jsonl`;
}

/** Runs one tool with the whole safety harness and returns its evidence. */
export async function runTool(
  tool: ChainTool,
  env: ChainEnv,
  body: ToolBody,
  deps: ToolDeps = {},
): Promise<Record<string, unknown>> {
  const root = deps.root ?? repoRoot();
  const frontDir = deps.frontDir ?? FRONT_DIR;
  const config = readChainConfig(tool, env, { root, home: deps.home });
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));

  const controller = new AbortController();
  const abort = () => controller.abort();
  const deadline = setTimeout(abort, config.deadlineMin * 60_000);
  deadline.unref?.();
  if (deps.signal) {
    if (deps.signal.aborted) controller.abort();
    else deps.signal.addEventListener("abort", abort, { once: true });
  }
  const handlers = deps.signalHandlers ?? false;
  if (handlers) {
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
  }
  const restoreFetch = installFetchGuard(config.rpcUrl);
  const clients = createChainRpc({
    url: config.rpcUrl,
    network: config.network,
    expectedGenesis: config.expectedGenesis,
    mode: config.send ? "send" : "read",
    rps: deps.rps ?? config.rps,
    signal: controller.signal,
    transport: deps.transport,
    retryDelayMs: deps.retryDelayMs,
    sleep: deps.timing?.sleep,
  });

  const evidence: Record<string, unknown> = {
    schema: `mancipatio-chain-${tool}-v1`,
    tool,
    status: "failed" satisfies ToolStatus,
    mode: config.recover ? "recover" : config.send ? "send" : "dry-run",
    network: config.network,
    genesisHash: config.expectedGenesis,
    rpcHost: config.rpcHost,
    headCommit: gitHead(root),
    startedUtc: new Date().toISOString(),
  };
  const ctx: ToolContext = {
    tool,
    env,
    config,
    deps,
    rpc: clients.rpc,
    drainRpc: clients.drainRpc,
    signal: controller.signal,
    root,
    frontDir,
    evidence,
    phase: "start",
    log,
    journal: null,
    lock: null,
    timing: deps.timing,
    beginSend: () => {
      if (ctx.journal) return ctx.journal;
      const journalPath = journalPathFor(config.output);
      assertOutputPath(journalPath, root, "the journal file");
      ctx.lock = acquireLock({
        stateDir: config.stateDir,
        network: config.network,
        genesis: config.expectedGenesis,
        tool,
        journalPath,
      });
      ctx.journal = new Journal(journalPath);
      evidence.journal = path.basename(journalPath);
      return ctx.journal;
    },
  };

  try {
    ctx.phase = "network";
    await clients.assertNetwork();
    ctx.phase = "run";
    evidence.status = config.recover ? await runRecovery(ctx) : await body(ctx);
  } catch (error) {
    evidence.status = (controller.signal.aborted || error instanceof ChainAbortError ? "aborted" : "failed") satisfies ToolStatus;
    evidence.error = publicErrorMessage(tool, ctx.phase, error);
    ctx.journal?.append({ event: "abort", reason: evidence.error });
  } finally {
    clearTimeout(deadline);
    deps.signal?.removeEventListener("abort", abort);
    if (handlers) {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
    if (ctx.lock && ctx.journal) {
      const pending = unresolvedSignatures(readJournal(ctx.journal.path));
      if (pending.length === 0) releaseLock(ctx.lock);
      else {
        evidence.lockKept = true;
        evidence.unresolvedSignatures = pending.map((entry) => ({ step: entry.step, signature: entry.sig }));
      }
    }
    ctx.journal?.close();
    evidence.rpcCalls = summarizeCalls(clients.calls);
    evidence.finishedUtc = new Date().toISOString();
    restoreFetch();
    fs.mkdirSync(path.dirname(config.output), { recursive: true });
    fs.writeFileSync(config.output, `${toJson(evidence)}\n`, { flag: "wx", mode: 0o600 });
    log(`evidence: ${path.basename(config.output)} (status ${String(evidence.status)})`);
    if (evidence.error) log(`error: ${String(evidence.error)}`);
  }
  return evidence;
}

function summarizeCalls(calls: { method: string; ok: boolean }[]) {
  const byMethod: Record<string, { ok: number; failed: number }> = {};
  for (const call of calls) {
    byMethod[call.method] ??= { ok: 0, failed: 0 };
    byMethod[call.method][call.ok ? "ok" : "failed"]++;
  }
  return byMethod;
}

/**
 * CHAIN_RECOVER=1: resolves the in-flight signatures a leftover lock points at
 * (§3.6 rules 4–5, no rebroadcast), appends the outcomes to that journal and
 * removes the lock when every signature is resolved. Sends nothing.
 */
export async function runRecovery(ctx: ToolContext): Promise<ToolStatus> {
  const { config } = ctx;
  const file = lockPath(config.stateDir, config.network, config.expectedGenesis);
  const info = readLock(file);
  if (!info) {
    ctx.evidence.recovery = { lockFound: false };
    ctx.log(`recover: no lock for ${config.network}`);
    return "completed";
  }
  if (!info.journalPath || !fs.existsSync(info.journalPath)) {
    throw new ChainGateError("The lock names no readable journal; inspect it manually before removing it");
  }
  const pending = unresolvedSignatures(readJournal(info.journalPath));
  const journal = new Journal(info.journalPath);
  const outcomes: { step: string; signature: string; status: string }[] = [];
  try {
    for (const entry of pending) {
      const outcome = await pollSignature({
        rpc: ctx.drainRpc,
        journal,
        step: entry.step,
        signature: entry.sig as never,
        lastValidBlockHeight: entry.lastValidBlockHeight,
        required: "finalized",
        timing: ctx.timing,
        eventName: "recover",
      });
      outcomes.push({ step: entry.step, signature: entry.sig, status: outcome.status });
      ctx.log(`recover ${entry.step} ${entry.sig.slice(0, 12)}…: ${outcome.status}`);
    }
  } finally {
    journal.close();
  }
  const still = unresolvedSignatures(readJournal(info.journalPath));
  if (still.length === 0) fs.rmSync(file, { force: true });
  ctx.evidence.recovery = {
    lockFound: true,
    lockTool: info.tool,
    lockStartedUtc: info.startedUtc,
    outcomes,
    lockRemoved: still.length === 0,
  };
  return still.length === 0 ? "completed" : "failed";
}
