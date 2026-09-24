/**
 * E2E_* variables of `npm run chain:e2e` (design-6.3 §E). Pure: the tool
 * passes its environment and the repository root. CHAIN_* variables are
 * read by safety.readChainConfig as for every chain tool.
 */
import path from "node:path";
import { isAddress, type Address } from "@solana/kit";
import type { Network } from "@/lib/network";
import { ChainGateError, type ChainEnv } from "../safety";
import { parseGroups, type E2eNetwork } from "./matrix";

export type E2eConfig = {
  network: E2eNetwork;
  /** Keys, state.json and the summary (git-ignored; one directory per network). */
  dir: string;
  groups: number[];
  /** Stable across resumed runs; fixed by the first run in state.json. */
  runId: string | null;
  /**
   * The key CHAIN_KEYPAIR must hold, known before any key is loaded (the
   * plan digest names it): the Admin on devnet, the deployer on localnet.
   */
  payer: Address;
  /** 0: stop with "awaiting" at a checkpoint instead of polling. */
  checkpointWaitMin: number;
  minPayerLamports: bigint;
  maxRequests: number;
};

const LAMPORTS_PER_SOL = 1_000_000_000;

function positiveNumber(env: ChainEnv, name: string, fallback: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > max) {
    throw new ChainGateError(`${name} must be a number from 0 to ${max}`);
  }
  return value;
}

export function readE2eConfig(env: ChainEnv, network: Network, root: string): E2eConfig {
  if (network !== "devnet" && network !== "localnet") {
    // Never mainnet, never testnet, whatever CHAIN_ALLOW_MAINNET says.
    throw new ChainGateError("chain:e2e runs on devnet or localnet only");
  }
  const dirRaw = env.E2E_DIR?.trim();
  const dir = path.resolve(dirRaw || path.join(root, "docs", "mainnet-readiness", "e2e-6.3", network));
  let groups: number[];
  try {
    groups = parseGroups(env.E2E_GROUPS?.trim() || (network === "localnet" ? "0-3" : "1-3"));
  } catch (error) {
    throw new ChainGateError((error as Error).message);
  }
  if (network === "devnet" && groups.includes(0)) {
    throw new ChainGateError("Group 0 (bootstrap) is localnet only; devnet already has its platform");
  }
  const runId = env.E2E_RUN_ID?.trim() || null;
  if (runId !== null && !/^[a-z0-9]{4,12}$/.test(runId)) {
    throw new ChainGateError("E2E_RUN_ID must be 4 to 12 lowercase letters or digits");
  }
  const payerRaw = env.E2E_PAYER?.trim() || null;
  if (!payerRaw) {
    throw new ChainGateError("E2E_PAYER is required: the Admin on devnet, the validator's deployer on localnet");
  }
  if (!isAddress(payerRaw)) throw new ChainGateError("E2E_PAYER is not a valid address");
  return {
    network,
    dir,
    groups,
    runId,
    payer: payerRaw as Address,
    checkpointWaitMin: positiveNumber(env, "E2E_CHECKPOINT_WAIT_MIN", 0, 180),
    minPayerLamports: BigInt(
      Math.round(positiveNumber(env, "E2E_MIN_PAYER_SOL", network === "devnet" ? 1 : 50, 1000) * LAMPORTS_PER_SOL),
    ),
    maxRequests: Math.floor(positiveNumber(env, "E2E_MAX_REQUESTS", network === "devnet" ? 2500 : 20000, 100000)),
  };
}
