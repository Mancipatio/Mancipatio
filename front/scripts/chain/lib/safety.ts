/**
 * Shared safety layer of the chain CLI (design-3.3 §3): environment gates,
 * the mainnet gate, the output-path guard, the hot-signer loader, the fetch
 * guard and the mainnet release-source guard.
 *
 * Every error thrown here carries public text only. It never contains an RPC
 * URL, a local path, key bytes or a seed phrase.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createKeyPairSignerFromBytes,
  isBlockhash,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import type { Network } from "@/lib/network";
import {
  CLUSTER_GENESIS_HASHES,
  NetworkIdentityError,
  expectedGenesisHash,
} from "@/lib/network-identity";

// ── Errors ────────────────────────────────────────────────────────────────────

/** A refused precondition. The message is public. */
export class ChainGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainGateError";
  }
}

/** The on-chain state or the plan does not allow the run. The message is public. */
export class ChainPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainPlanError";
  }
}

/** The run was interrupted (deadline, SIGINT or SIGTERM). The message is public. */
export class ChainAbortError extends ChainGateError {
  constructor(message = "Run aborted: deadline reached or interrupted") {
    super(message);
    this.name = "ChainAbortError";
  }
}

/** An RPC failure with every provider detail withheld. */
export class ChainRpcError extends Error {
  readonly method: string;
  readonly code: number | null;
  constructor(method: string, code: number | null = null) {
    super(`RPC ${method} failed; details withheld`);
    this.name = "ChainRpcError";
    this.method = method;
    this.code = code;
  }
}

export type ChainTool = "bootstrap" | "idl" | "inventory" | "squads-export";

/** The text a runner may print or store for `error`. */
export function publicErrorMessage(
  tool: ChainTool,
  phase: string,
  error: unknown,
): string {
  if (
    error instanceof ChainGateError ||
    error instanceof ChainPlanError ||
    error instanceof ChainRpcError ||
    error instanceof NetworkIdentityError
  ) {
    return error.message;
  }
  return `${tool} failed during ${phase}; sensitive details withheld`;
}

// ── Small helpers ─────────────────────────────────────────────────────────────

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Canonical JSON: sorted object keys, bigint as a decimal string. */
export function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (typeof input === "bigint") return input.toString();
    if (input instanceof Uint8Array) return Buffer.from(input).toString("base64");
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.keys(input as Record<string, unknown>)
          .sort()
          .filter((key) => (input as Record<string, unknown>)[key] !== undefined)
          .map((key) => [key, normalize((input as Record<string, unknown>)[key])]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

/** JSON.stringify that turns bigint into strings and Uint8Array into base64. */
export function toJson(value: unknown, space = 2): string {
  return JSON.stringify(
    value,
    (_key, v) =>
      typeof v === "bigint"
        ? v.toString()
        : v instanceof Uint8Array
          ? Buffer.from(v).toString("base64")
          : v,
    space,
  );
}

export const FRONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** The git top level that contains front/ (a worktree root in a worktree). */
export function repoRoot(frontDir = FRONT_DIR): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: frontDir,
    encoding: "utf8",
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new ChainGateError("Cannot locate the repository root (git rev-parse failed)");
  }
  return result.stdout.trim();
}

export function gitHead(root: string): string | null {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

// ── Environment (runner contract, design §3.1) ────────────────────────────────

export type ChainEnv = Readonly<Record<string, string | undefined>>;

/** Default internal deadlines in minutes (design §3.8). */
export const DEFAULT_DEADLINE_MIN: Record<ChainTool, number> = {
  inventory: 20,
  bootstrap: 60,
  idl: 120,
  "squads-export": 10,
};
/** The runner's own vitest timeout is 4 h; the internal deadline stays below it. */
export const MAX_DEADLINE_MIN = 230;
export const MAX_CU_PRICE = BigInt(2_000_000);
export const DEFAULT_RPS = 2;
export const MAX_RPS = 20;

export type RehearsalRole = "superAdmin" | "blocklistAuthority" | "kycAuthority";
const REHEARSAL_ROLES: readonly RehearsalRole[] = [
  "superAdmin",
  "blocklistAuthority",
  "kycAuthority",
];

export type ChainConfig = {
  tool: ChainTool;
  network: Network;
  rpcUrl: string;
  /** Hostname only; the only part of the RPC URL that evidence keeps. */
  rpcHost: string;
  expectedGenesis: string;
  allowMainnet: boolean;
  output: string;
  roleMapPath: string | null;
  releaseDir: string | null;
  send: boolean;
  keypairPath: string | null;
  confirmPlan: string | null;
  cuPrice: bigint | null;
  rps: number;
  deadlineMin: number;
  rehearsalSigners: Partial<Record<RehearsalRole, string>>;
  recover: boolean;
  /** Lock directory; `CHAIN_STATE_DIR` or ~/.mancipatio/chain. */
  stateDir: string;
};

const NETWORKS: readonly Network[] = ["mainnet", "devnet", "testnet", "localnet"];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function flag(env: ChainEnv, name: string): boolean {
  const value = env[name]?.trim();
  if (value === undefined || value === "" || value === "0") return false;
  if (value === "1") return true;
  throw new ChainGateError(`${name} must be 1 or unset`);
}

function nonEmpty(env: ChainEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

/** Validates the RPC URL. Errors never echo the value. */
export function parseRpcUrl(value: string | null, network: Network): URL {
  if (!value) throw new ChainGateError("CHAIN_RPC_URL is required");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ChainGateError("CHAIN_RPC_URL is not a valid URL (value withheld)");
  }
  if (url.username || url.password) {
    throw new ChainGateError("CHAIN_RPC_URL must not carry credentials in userinfo (value withheld)");
  }
  const loopbackHttp =
    url.protocol === "http:" && network === "localnet" && LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttp) {
    throw new ChainGateError(
      "CHAIN_RPC_URL must use https (localnet may use http on a loopback host)",
    );
  }
  return url;
}

/** The genesis the run is pinned to. Always a defined string (design §3.2.1). */
export function resolveExpectedGenesis(network: Network, configured: string | null): string {
  if (network === "localnet") {
    if (!configured) {
      throw new ChainGateError("CHAIN_GENESIS_HASH is required on localnet");
    }
    try {
      return expectedGenesisHash("localnet", configured);
    } catch {
      throw new ChainGateError(
        "CHAIN_GENESIS_HASH must be a valid localnet genesis hash that is not a public cluster's",
      );
    }
  }
  const expected = CLUSTER_GENESIS_HASHES[network];
  if (configured && configured !== expected) {
    throw new ChainGateError(`CHAIN_GENESIS_HASH conflicts with the ${network} genesis hash`);
  }
  return expected;
}

function parseRehearsal(
  value: string | null,
  network: Network,
): Partial<Record<RehearsalRole, string>> {
  if (!value) return {};
  if (network !== "localnet" && network !== "devnet") {
    throw new ChainGateError("CHAIN_REHEARSAL_SIGNERS is allowed on localnet and devnet only");
  }
  const out: Partial<Record<RehearsalRole, string>> = {};
  for (const part of value.split(",")) {
    const index = part.indexOf("=");
    const role = part.slice(0, index).trim() as RehearsalRole;
    const file = part.slice(index + 1).trim();
    if (index <= 0 || !file || !REHEARSAL_ROLES.includes(role) || out[role]) {
      throw new ChainGateError(
        "CHAIN_REHEARSAL_SIGNERS must be role=keypair pairs (superAdmin, blocklistAuthority, kycAuthority), comma separated",
      );
    }
    out[role] = file;
  }
  return out;
}

export type ReadConfigOptions = {
  /** Repository root for the output-path guard. */
  root?: string;
  /** Home directory for the default lock directory. */
  home?: string;
};

/**
 * Parses and validates every CHAIN_* variable for one tool. Tool-specific
 * variables (CHAIN_PHASE, CHAIN_IDL_*, CHAIN_SQUADS_*, CHAIN_HANDOVER*) are
 * read by the tools themselves.
 */
export function readChainConfig(
  tool: ChainTool,
  env: ChainEnv,
  options: ReadConfigOptions = {},
): ChainConfig {
  const rawNetwork = nonEmpty(env, "CHAIN_NETWORK");
  if (!rawNetwork) throw new ChainGateError("CHAIN_NETWORK is required");
  const network = rawNetwork.toLowerCase() as Network;
  if (!NETWORKS.includes(network)) {
    throw new ChainGateError("CHAIN_NETWORK must be mainnet, devnet, testnet or localnet");
  }
  const publicNetwork = nonEmpty(env, "NEXT_PUBLIC_NETWORK");
  if (publicNetwork && publicNetwork.toLowerCase() !== network) {
    throw new ChainGateError("CHAIN_NETWORK conflicts with NEXT_PUBLIC_NETWORK");
  }
  const allowMainnet = flag(env, "CHAIN_ALLOW_MAINNET");
  if (network === "mainnet" && !allowMainnet) {
    throw new ChainGateError("A mainnet run needs CHAIN_ALLOW_MAINNET=1");
  }
  const url = parseRpcUrl(nonEmpty(env, "CHAIN_RPC_URL"), network);
  const expectedGenesis = resolveExpectedGenesis(network, nonEmpty(env, "CHAIN_GENESIS_HASH"));

  const output = nonEmpty(env, "CHAIN_OUTPUT");
  if (!output) throw new ChainGateError("CHAIN_OUTPUT is required (evidence file; never overwritten)");
  const root = options.root ?? repoRoot();
  assertOutputPath(output, root, "CHAIN_OUTPUT");

  const roleMapPath = nonEmpty(env, "CHAIN_ROLE_MAP");
  if ((tool === "bootstrap" || tool === "squads-export") && !roleMapPath) {
    throw new ChainGateError(`CHAIN_ROLE_MAP is required for ${tool}`);
  }
  const releaseDir = nonEmpty(env, "CHAIN_RELEASE_DIR");
  if (network === "mainnet" && tool !== "inventory" && !releaseDir) {
    throw new ChainGateError(`CHAIN_RELEASE_DIR is required for a mainnet ${tool} run`);
  }

  const send = flag(env, "CHAIN_SEND");
  const recover = flag(env, "CHAIN_RECOVER");
  if (send && (tool === "inventory" || tool === "squads-export")) {
    throw new ChainGateError(`${tool} never sends; unset CHAIN_SEND`);
  }
  if (send && recover) throw new ChainGateError("CHAIN_SEND and CHAIN_RECOVER are exclusive");
  const keypairPath = nonEmpty(env, "CHAIN_KEYPAIR");
  const confirmPlan = nonEmpty(env, "CHAIN_CONFIRM_PLAN");
  if (send && (!keypairPath || !confirmPlan)) {
    throw new ChainGateError("Send mode needs CHAIN_SEND=1, CHAIN_KEYPAIR and CHAIN_CONFIRM_PLAN");
  }
  if (!send && keypairPath) {
    // A keypair without send mode is never loaded; refuse the ambiguity.
    throw new ChainGateError("CHAIN_KEYPAIR is only read in send mode");
  }

  const cuRaw = nonEmpty(env, "CHAIN_CU_PRICE");
  let cuPrice: bigint | null = null;
  if (cuRaw !== null) {
    if (!/^\d{1,9}$/.test(cuRaw)) throw new ChainGateError("CHAIN_CU_PRICE must be an integer (micro-lamports)");
    cuPrice = BigInt(cuRaw);
    if (cuPrice > MAX_CU_PRICE) throw new ChainGateError("CHAIN_CU_PRICE is capped at 2,000,000 micro-lamports");
  }
  if (network === "mainnet" && send && cuPrice === null) {
    throw new ChainGateError("CHAIN_CU_PRICE is required when sending on mainnet");
  }

  const rpsRaw = nonEmpty(env, "CHAIN_RPS");
  const rps = rpsRaw === null ? DEFAULT_RPS : Number(rpsRaw);
  if (!Number.isInteger(rps) || rps < 1 || rps > MAX_RPS) {
    throw new ChainGateError("CHAIN_RPS must be an integer from 1 to 20");
  }
  const deadlineRaw = nonEmpty(env, "CHAIN_DEADLINE_MIN");
  const deadlineMin = deadlineRaw === null ? DEFAULT_DEADLINE_MIN[tool] : Number(deadlineRaw);
  if (!Number.isFinite(deadlineMin) || deadlineMin <= 0 || deadlineMin > MAX_DEADLINE_MIN) {
    throw new ChainGateError(`CHAIN_DEADLINE_MIN must be between 0 and ${MAX_DEADLINE_MIN} minutes`);
  }

  const rehearsalSigners = parseRehearsal(nonEmpty(env, "CHAIN_REHEARSAL_SIGNERS"), network);
  // The per-network lock only excludes runs that share its directory: on
  // mainnet every run uses the one default directory.
  const defaultStateDir = path.join(options.home ?? os.homedir(), ".mancipatio", "chain");
  const stateDirRaw = nonEmpty(env, "CHAIN_STATE_DIR");
  if (network === "mainnet" && stateDirRaw !== null && path.resolve(stateDirRaw) !== path.resolve(defaultStateDir)) {
    throw new ChainGateError("CHAIN_STATE_DIR cannot move the lock directory on mainnet");
  }
  const stateDir = path.resolve(stateDirRaw ?? defaultStateDir);

  return {
    tool,
    network,
    rpcUrl: url.href,
    rpcHost: url.hostname,
    expectedGenesis,
    allowMainnet,
    output: path.resolve(output),
    roleMapPath: roleMapPath ? path.resolve(roleMapPath) : null,
    releaseDir: releaseDir ? path.resolve(releaseDir) : null,
    send,
    keypairPath: keypairPath ? path.resolve(keypairPath) : null,
    confirmPlan,
    cuPrice,
    rps,
    deadlineMin,
    rehearsalSigners,
    recover,
    stateDir,
  };
}

// ── Output-path guard ────────────────────────────────────────────────────────

/**
 * Refuses an existing file, and a path inside the repository that git does
 * not ignore (evidence must never land in a tracked or trackable file).
 */
export function assertOutputPath(file: string, root: string, label: string): void {
  const absolute = path.resolve(file);
  if (fs.existsSync(absolute)) {
    throw new ChainGateError(`${label} already exists; evidence files are never overwritten`);
  }
  const relative = path.relative(root, absolute);
  const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  if (!inside) return;
  const result = spawnSync("git", ["check-ignore", "-q", "--", relative], { cwd: root });
  if (result.status !== 0) {
    throw new ChainGateError(`${label} is inside the repository and not git-ignored`);
  }
}

// ── Hot signer (design §3.4) ─────────────────────────────────────────────────

/**
 * Reads a 64-byte JSON keypair, asserts its address and zeroes the buffer.
 * No error carries the path or any byte of the file.
 */
export async function loadHotSigner(
  file: string,
  expected: Address,
  role: string,
): Promise<KeyPairSigner> {
  let bytes: Uint8Array | null = null;
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw new ChainGateError(`The ${role} keypair file is unreadable (path withheld)`);
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 64 ||
      !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ) {
      throw new ChainGateError(`The ${role} keypair file is not a 64-byte keypair (path withheld)`);
    }
    bytes = Uint8Array.from(parsed as number[]);
    (parsed as number[]).fill(0);
    let signer: KeyPairSigner;
    try {
      signer = await createKeyPairSignerFromBytes(bytes);
    } catch {
      throw new ChainGateError(`The ${role} keypair is invalid (details withheld)`);
    }
    if (signer.address !== expected) {
      throw new ChainGateError(`The ${role} keypair is not the expected key ${expected}`);
    }
    return signer;
  } finally {
    bytes?.fill(0);
  }
}

// ── Fetch guard (design §3.3) ─────────────────────────────────────────────────

/**
 * Only the configured RPC origin and path are reachable while a tool runs.
 * Returns the function that restores the previous `fetch`.
 */
export function installFetchGuard(rpcUrl: string): () => void {
  const allowed = new URL(rpcUrl);
  const original = globalThis.fetch;
  const guarded: typeof fetch = (input, init) => {
    let target: URL;
    try {
      target = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
    } catch {
      return Promise.reject(new ChainGateError("Outbound request refused (invalid URL)"));
    }
    if (target.origin !== allowed.origin || target.pathname !== allowed.pathname) {
      return Promise.reject(
        new ChainGateError("Outbound request refused: only the configured RPC endpoint is reachable"),
      );
    }
    return original(input, init);
  };
  globalThis.fetch = guarded;
  return () => {
    if (globalThis.fetch === guarded) globalThis.fetch = original;
  };
}

// ── Release-source guard (design §3.2.3) ─────────────────────────────────────

export const IDL_PROGRAMS = ["asset_registry", "transfer_hook"] as const;
export type ProgramName = (typeof IDL_PROGRAMS)[number];

/**
 * Paths whose working tree must be clean for a mainnet run: everything the
 * chain lib imports (front/lib, the Release parsers in scripts/ops) plus the
 * dependency pins.
 */
export const SOURCE_INTEGRITY_PATHS = [
  "front/idl",
  "front/lib",
  "front/scripts/chain",
  "front/scripts/ops/artifact-provenance.mjs",
  "front/package.json",
  "front/package-lock.json",
];

export function dirtySourcePaths(root: string): string[] {
  const result = spawnSync("git", ["status", "--porcelain", "--", ...SOURCE_INTEGRITY_PATHS], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new ChainGateError("git status failed during the source-integrity check");
  return result.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

/**
 * On mainnet the committed IDL must be byte-identical to the Release IDL and
 * front/idl, front/lib and front/scripts/chain must be clean. CI
 * `check:codegen` then ties the SDK to that IDL.
 */
export function assertReleaseSource(input: {
  network: Network;
  root: string;
  localIdl: Record<ProgramName, Uint8Array>;
  releaseIdl: Record<ProgramName, Uint8Array> | null;
  dirty?: string[];
}): void {
  if (input.network !== "mainnet") return;
  if (!input.releaseIdl) throw new ChainGateError("The Release has no IDL files; a mainnet run needs them");
  for (const name of IDL_PROGRAMS) {
    if (sha256Hex(input.localIdl[name]) !== sha256Hex(input.releaseIdl[name])) {
      throw new ChainGateError(`front/idl/${name}.json differs from the Release IDL`);
    }
  }
  const dirty = input.dirty ?? dirtySourcePaths(input.root);
  if (dirty.length) {
    throw new ChainGateError(
      `The working tree has uncommitted changes under ${SOURCE_INTEGRITY_PATHS.join(", ")} (${dirty.length} paths)`,
    );
  }
}

export function readLocalIdl(frontDir = FRONT_DIR): Record<ProgramName, Uint8Array> {
  return Object.fromEntries(
    IDL_PROGRAMS.map((name) => [name, new Uint8Array(fs.readFileSync(path.join(frontDir, "idl", `${name}.json`)))]),
  ) as Record<ProgramName, Uint8Array>;
}

export function isValidGenesis(value: string): boolean {
  return isBlockhash(value);
}
