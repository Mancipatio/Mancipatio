/**
 * Safety layer of the simulator (design-sim §7): the environment contract,
 * the devnet-only gates, the two-origin fetch guard, private files, the
 * STOP / PAUSE switches, the chain CLI's devnet lock during a cohort-X loan
 * and the redaction every journal line goes through.
 *
 * Error messages are public: they never carry the RPC URL, a local path or
 * key material.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAddress } from "@solana/kit";
import { acquireLock, lockPath, readLock, type HeldLock } from "@/scripts/chain/lib/journal";
import {
  ChainGateError,
  parseRpcUrl,
  resolveExpectedGenesis,
  type ChainEnv,
} from "@/scripts/chain/lib/safety";
import { PACE, SITE_ORIGIN, SIM_NETWORK } from "./constants";

export const SIM_CMDS = ["plan", "pilot", "wave", "watch", "report"] as const;
export type SimCmd = (typeof SIM_CMDS)[number];
/** Commands that talk to the site and the chain. */
export const NETWORK_CMDS: readonly SimCmd[] = ["pilot", "wave", "watch"];
/** Waves 1–5 hold the first 100 users; wave 6 the transfer pairs (cohort X). */
export const WAVES = [1, 2, 3, 4, 5, 6] as const;

export class SimGateError extends ChainGateError {
  constructor(message: string) {
    super(message);
    this.name = "SimGateError";
  }
}

/** A clean stop (STOP file, SIGINT, maintenance, a circuit breaker). */
export class SimStopError extends Error {
  constructor(readonly reason: string) {
    super(`Simulator stopped: ${reason}`);
    this.name = "SimStopError";
  }
}

export type SimConfig = {
  cmd: SimCmd;
  wave: number | null;
  runId: string | null;
  /** docs/mainnet-readiness/sim (git-ignored): run dirs, report.md, STOP, PAUSE. */
  simRoot: string;
  rpcUrl: string | null;
  rpcHost: string | null;
  expectedGenesis: string;
  rps: number;
  send: boolean;
  deployerKeypair: string;
  adminKeypair: string;
  /** e2e buyer3's key (SIM_DONOR_KEYPAIR): signs only a cohort-X loan's seed leg; null = no loan. */
  donorKeypair: string | null;
  /** The chain CLI's lock directory (CHAIN_STATE_DIR, default ~/.mancipatio/chain). */
  chainStateDir: string;
  e2eStatePath: string;
  kycRegistry: string | null;
  workers: number;
  watchMaxMin: number;
  watchOnce: boolean;
};

function value(env: ChainEnv, name: string): string | null {
  const raw = env[name]?.trim();
  return raw ? raw : null;
}

function intIn(env: ChainEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = value(env, name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new SimGateError(`${name} must be an integer from ${min} to ${max}`);
  }
  return n;
}

/**
 * Parses SIM_* and the CHAIN_* variables the simulator shares with the chain
 * CLI. Devnet only: mainnet, testnet and localnet are refused whatever
 * CHAIN_ALLOW_MAINNET says, and setting that flag at all is refused.
 */
export function readSimConfig(
  env: ChainEnv,
  options: { root: string; home?: string },
): SimConfig {
  const cmd = value(env, "SIM_CMD") as SimCmd | null;
  if (!cmd || !SIM_CMDS.includes(cmd)) {
    throw new SimGateError(`SIM_CMD must be one of ${SIM_CMDS.join(", ")}`);
  }
  let wave: number | null = null;
  if (cmd === "wave") {
    wave = intIn(env, "SIM_WAVE", 0, 1, WAVES.length);
    if (wave === 0) throw new SimGateError(`SIM_WAVE (1-${WAVES.length}) is required for SIM_CMD=wave`);
  } else if (value(env, "SIM_WAVE") !== null) {
    throw new SimGateError("SIM_WAVE is only read by SIM_CMD=wave");
  }
  if (value(env, "CHAIN_ALLOW_MAINNET") !== null) {
    throw new SimGateError("The simulator never runs on mainnet; unset CHAIN_ALLOW_MAINNET");
  }
  const rawNetwork = value(env, "CHAIN_NETWORK")?.toLowerCase() ?? null;
  const networked = NETWORK_CMDS.includes(cmd);
  if (rawNetwork !== null && rawNetwork !== SIM_NETWORK) {
    throw new SimGateError(`The simulator runs on devnet only (CHAIN_NETWORK=${rawNetwork} refused)`);
  }
  if (networked && rawNetwork === null) throw new SimGateError("CHAIN_NETWORK=devnet is required");
  const publicNetwork = value(env, "NEXT_PUBLIC_NETWORK")?.toLowerCase() ?? null;
  if (publicNetwork !== null && publicNetwork !== SIM_NETWORK) {
    throw new SimGateError("NEXT_PUBLIC_NETWORK conflicts with the devnet-only simulator");
  }
  const site = value(env, "SIM_SITE");
  if (site !== null && site !== SITE_ORIGIN) {
    throw new SimGateError(`SIM_SITE must be exactly ${SITE_ORIGIN} (the signed origin)`);
  }

  let rpcUrl: string | null = null;
  let rpcHost: string | null = null;
  if (networked) {
    const url = parseRpcUrl(value(env, "CHAIN_RPC_URL"), SIM_NETWORK);
    if (url.hostname.includes("mainnet") || url.hostname.includes("testnet")) {
      throw new SimGateError("CHAIN_RPC_URL names another cluster (value withheld)");
    }
    rpcUrl = url.href;
    rpcHost = url.hostname;
  }
  const expectedGenesis = resolveExpectedGenesis(SIM_NETWORK, value(env, "CHAIN_GENESIS_HASH"));
  const rps = intIn(env, "CHAIN_RPS", PACE.chainRps, 1, 5);

  const sendRaw = value(env, "SIM_SEND");
  if (sendRaw !== null && sendRaw !== "1" && sendRaw !== "0") throw new SimGateError("SIM_SEND must be 1 or unset");
  const send = sendRaw === "1";
  if (networked && !send) {
    throw new SimGateError(`SIM_CMD=${cmd} writes to devnet manci.io; confirm with SIM_SEND=1`);
  }
  if (!networked && send) throw new SimGateError(`SIM_CMD=${cmd} never sends; unset SIM_SEND`);

  const runId = value(env, "SIM_RUN_ID");
  if (runId !== null && !/^[a-z0-9]{6}$/.test(runId)) {
    throw new SimGateError("SIM_RUN_ID must be 6 lowercase letters or digits");
  }
  const home = options.home ?? os.homedir();
  const simRoot = path.resolve(value(env, "SIM_DIR") ?? path.join(options.root, "docs", "mainnet-readiness", "sim"));
  const kycRegistry = value(env, "SIM_KYC_REGISTRY");
  if (kycRegistry !== null && !isAddress(kycRegistry)) throw new SimGateError("SIM_KYC_REGISTRY is not an address");
  const watchOnce = value(env, "SIM_WATCH_ONCE") === "1";
  const donor = value(env, "SIM_DONOR_KEYPAIR");
  return {
    cmd,
    wave,
    runId,
    simRoot,
    rpcUrl,
    rpcHost,
    expectedGenesis,
    rps,
    send,
    deployerKeypair: path.resolve(value(env, "SIM_DEPLOYER_KEYPAIR") ?? path.join(home, ".config", "solana", "id-devnet.json")),
    adminKeypair: path.resolve(value(env, "SIM_ADMIN_KEYPAIR") ?? path.join(home, ".config", "solana", "manci-e2e-admin.json")),
    donorKeypair: donor === null ? null : path.resolve(donor),
    // The same default as the chain CLI (scripts/chain/lib/safety.ts): one lock per network.
    chainStateDir: path.resolve(value(env, "CHAIN_STATE_DIR") ?? path.join(home, ".mancipatio", "chain")),
    e2eStatePath: path.resolve(
      value(env, "SIM_E2E_STATE") ?? path.join(options.root, "docs", "mainnet-readiness", "e2e-6.3", "devnet", "state.json"),
    ),
    kycRegistry,
    workers: intIn(env, "SIM_WORKERS", PACE.httpConcurrency, 1, PACE.httpConcurrency),
    watchMaxMin: intIn(env, "SIM_WATCH_MAX_MIN", 230, 1, 230),
    watchOnce,
  };
}

// ── Output location ──────────────────────────────────────────────────────────

/** The sim directory must be inside the repository and git-ignored (keys live there). */
export function assertIgnoredDir(dir: string, root: string): void {
  const relative = path.relative(root, dir);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new SimGateError("SIM_DIR must be inside the repository (a git-ignored path)");
  }
  const probe = path.join(relative, "state.json");
  const result = spawnSync("git", ["check-ignore", "-q", "--", probe], { cwd: root });
  if (result.status !== 0) throw new SimGateError("SIM_DIR is not git-ignored; keys and state must never be tracked");
}

export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** Atomic write (temp file + rename), mode 600. */
export function writePrivateFile(file: string, content: string | Uint8Array): void {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

// ── Fetch guard ──────────────────────────────────────────────────────────────

/**
 * While the simulator runs only two destinations are reachable: the site
 * origin (any path) and the configured RPC endpoint (its exact origin and
 * path). Everything else (the apex domain, a preview URL, Supabase, the
 * faucet) is refused before a socket opens. Returns the restore function.
 */
export function simFetchAllowed(target: URL, rpcUrl: string | null, site = SITE_ORIGIN): boolean {
  if (target.origin === site) return true;
  if (!rpcUrl) return false;
  const rpc = new URL(rpcUrl);
  return target.origin === rpc.origin && target.pathname === rpc.pathname;
}

export function installSimFetchGuard(rpcUrl: string | null, site = SITE_ORIGIN): () => void {
  const original = globalThis.fetch;
  const guarded: typeof fetch = (input, init) => {
    let target: URL;
    try {
      target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    } catch {
      return Promise.reject(new SimGateError("Outbound request refused (invalid URL)"));
    }
    if (!simFetchAllowed(target, rpcUrl, site)) {
      return Promise.reject(new SimGateError(`Outbound request refused: only ${site} and the configured RPC endpoint are reachable`));
    }
    return original(input, init);
  };
  globalThis.fetch = guarded;
  return () => {
    if (globalThis.fetch === guarded) globalThis.fetch = original;
  };
}

// ── One simulator process ────────────────────────────────────────────────────

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * `<simRoot>/sim.lock` (created with `wx`): a second simulator process is
 * refused (design §1: never several processes on one IP). A lock whose pid is
 * gone is taken over. Returns the release function.
 */
export function acquireSimLock(simRoot: string): () => void {
  const file = path.join(simRoot, "sim.lock");
  const write = () => {
    const fd = fs.openSync(file, "wx", 0o600);
    fs.writeSync(fd, `${JSON.stringify({ pid: process.pid, startedUtc: new Date().toISOString() })}\n`);
    fs.closeSync(fd);
  };
  try {
    write();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw new SimGateError("Cannot create the simulator lock");
    let pid = -1;
    try {
      pid = (JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number }).pid ?? -1;
    } catch {
      pid = -1;
    }
    if (pidAlive(pid)) throw new SimGateError(`Another simulator process (pid ${pid}) is running; one process at a time`);
    fs.rmSync(file, { force: true });
    write();
  }
  return () => {
    try {
      const held = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number };
      if (held.pid === process.pid) fs.rmSync(file, { force: true });
    } catch {
      // already gone
    }
  };
}

// ── The chain CLI's devnet lock ─────────────────────────────────────────────

/** The tool name the simulator writes into the chain CLI's lock file. */
export const SIM_CHAIN_TOOL = "manci-sim";

/**
 * Takes the chain CLI's per-network lock (`<CHAIN_STATE_DIR>/devnet-<genesis8>.lock`,
 * scripts/chain/lib/journal.ts) for a cohort-X loan of e2e buyer3's units
 * (design-transfers §A(iii)): while the simulator holds it a `chain:e2e`
 * devnet run is refused, and while chain:e2e holds it no loan starts.
 *
 * - The lock names the simulator's tx-journal, so CHAIN_RECOVER=1 can resolve
 *   a lock a crashed simulator left behind.
 * - A lock this tool left (same journal, its pid gone) is taken over; any
 *   other lock is refused. No error names a path.
 * - It does not protect a loan between two commands: report.md and
 *   owner-queue.txt show an outstanding loan instead.
 */
export function acquireChainLock(input: { stateDir: string; genesis: string; journalPath: string }): HeldLock {
  const args = { stateDir: input.stateDir, network: SIM_NETWORK, genesis: input.genesis, tool: SIM_CHAIN_TOOL, journalPath: input.journalPath };
  try {
    return acquireLock(args);
  } catch (error) {
    if (!(error instanceof ChainGateError)) throw error;
    const file = lockPath(input.stateDir, SIM_NETWORK, input.genesis);
    const held = readLock(file);
    const ours = held !== null && held.tool === SIM_CHAIN_TOOL && held.journalPath === input.journalPath;
    if (!held || !ours || pidAlive(held.pid)) {
      const who = held ? `${held.tool}${pidAlive(held.pid) ? `, pid ${held.pid}` : ", no live process"}` : "unreadable";
      throw new SimGateError(`The chain CLI's devnet lock is held (${who}); no cohort-X loan while another chain run may send`);
    }
    fs.rmSync(file, { force: true });
    return acquireLock(args);
  }
}

// ── STOP / PAUSE ─────────────────────────────────────────────────────────────

/** `<simRoot>/STOP` (or SIGINT) ends the run after the current step; `<simRoot>/PAUSE` suspends it. */
export class StopControl {
  constructor(
    private readonly simRoot: string,
    readonly signal: AbortSignal,
  ) {}
  get stopFile(): string {
    return path.join(this.simRoot, "STOP");
  }
  get pauseFile(): string {
    return path.join(this.simRoot, "PAUSE");
  }
  stopReason(): string | null {
    if (this.signal.aborted) return "interrupted (SIGINT/SIGTERM)";
    if (fs.existsSync(this.stopFile)) return "STOP file present";
    return null;
  }
  paused(): boolean {
    return fs.existsSync(this.pauseFile);
  }
}

// ── Redaction ────────────────────────────────────────────────────────────────

const SECRET_KEYS = /token|cookie|signature|secret|session|password|authorization|private/i;

/** Deep copy with credentials replaced; onboarding links keep their path, not their token. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth]";
  if (typeof value === "string") return value.replace(/([?&]t=)[^&\s"]+/g, "$1[redacted]");
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SECRET_KEYS.test(k) && k !== "tos_version" ? "[redacted]" : redact(v, depth + 1),
      ]),
    );
  }
  return value;
}

/** A response body for the journal: parsed and redacted when JSON, capped at `max` bytes. */
export function journalBody(text: string, max = 2_048): string {
  let out: string;
  try {
    out = JSON.stringify(redact(JSON.parse(text)));
  } catch {
    out = String(redact(text));
  }
  return out.length > max ? `${out.slice(0, max)}…` : out;
}
