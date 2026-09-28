/**
 * Localnet clock warp (design-6.3 §D): the 7-day recoveries, the 48-hour
 * grants and rotations, the 30-day KYC grace and three missed payout months
 * cannot be waited out, so on localnet the run restarts its own validator
 * with `--warp-slot` (scripts/chain/e2e-localnet.sh warp). Opt-in
 * (E2E_WARP=1), localnet only, and only against the validator that script
 * runs (its RPC port must be CHAIN_RPC_URL's); anything else gets no warp and
 * the time-bound steps are recorded as not run.
 *
 * The Clock sysvar after a warp (measured on Agave 4.2.2, and re-read here):
 * the restart's root timestamp plus 75 % of 400 ms for every slot since the
 * epoch's first slot in epoch 0, and half that rate in later epochs. A jump
 * inside the current epoch is therefore at least that rate times the slots
 * the epoch has already run, so a smaller jump crosses into the next epoch;
 * the loop re-reads the clock and warps again until the target is reached.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import type { Journal } from "../journal";
import type { ChainRpc } from "../rpc";
import { ChainGateError, ChainPlanError, type ChainEnv } from "../safety";
import { ChainHaltError } from "../tx";
import { chainNow } from "./clock";

export type WarpFn = (target: bigint, label: string) => Promise<void>;

/** Seconds past the target a warp aims for (the clock must be past, not at, a deadline). */
export const WARP_MARGIN_S = BigInt(300);
/** Slots kept clear of the current slot and of the epoch's last slot. */
const SLOT_GUARD = BigInt(2_000);
const MAX_WARPS = 8;

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - BigInt(1)) / b;
}

/** Slots needed for `seconds` of clock at the post-warp rate of `epoch` (3/10 s, later 3/20 s). */
export function slotsForSeconds(epoch: bigint, seconds: bigint): bigint {
  return epoch === BigInt(0) ? ceilDiv(seconds * BigInt(10), BigInt(3)) : ceilDiv(seconds * BigInt(20), BigInt(3));
}

/**
 * The slot to warp to for about `need` seconds of chain time (pure): inside
 * the current epoch when that is past the current slot, else in the next
 * epoch (capped at its end; the caller warps again when it falls short).
 */
export function planWarpSlot(input: {
  epoch: bigint;
  slotIndex: bigint;
  slotsInEpoch: bigint;
  absoluteSlot: bigint;
  need: bigint;
}): bigint {
  if (input.need <= BigInt(0)) throw new ChainPlanError("A warp needs a positive number of seconds");
  const start = input.absoluteSlot - input.slotIndex;
  const end = start + input.slotsInEpoch;
  const within = start + slotsForSeconds(input.epoch, input.need);
  if (within > input.absoluteSlot + SLOT_GUARD && within < end - SLOT_GUARD) return within;
  const next = end + slotsForSeconds(input.epoch + BigInt(1), input.need);
  return next < end + input.slotsInEpoch - SLOT_GUARD ? next : end + input.slotsInEpoch - SLOT_GUARD;
}

/** Longest a warp may take: the restart plus the settle the script waits for. */
const WARP_TIMEOUT_MS = 20 * 60_000;

/**
 * Runs e2e-localnet.sh without blocking the event loop (the run's abort
 * signal stays live); the script gets the run's environment (its ports).
 */
function runScript(
  script: string,
  args: string[],
  cwd: string,
  env: ChainEnv,
  signal?: AbortSignal,
): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [script, ...args], { cwd, env: { ...env } as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGTERM"), WARP_TIMEOUT_MS);
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (status, killedBy) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({ status, signal: killedBy, stdout, stderr });
    });
  });
}

function tail(text: string | null | undefined, lines = 6): string {
  return (text ?? "").trim().split("\n").slice(-lines).join(" | ");
}

/**
 * The warp of this run, or null when warping is off. Refuses (gate) a warp
 * request that could restart anything but the loopback validator the script
 * manages: another network, a non-loopback RPC, or an RPC port that is not
 * the script's.
 */
export function localnetWarp(input: {
  enabled: boolean;
  network: string;
  rpcUrl: string;
  env: ChainEnv;
  /** The front/ directory (the script's home). */
  frontDir: string;
  rpc: ChainRpc;
  journal: Journal;
  log: (line: string) => void;
  /** The run's abort signal: a warp in progress is stopped with the run. */
  signal?: AbortSignal;
}): WarpFn | null {
  if (!input.enabled) return null;
  if (input.network !== "localnet") throw new ChainGateError("E2E_WARP is localnet only");
  const url = new URL(input.rpcUrl);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new ChainGateError("E2E_WARP needs CHAIN_RPC_URL on 127.0.0.1 (the e2e-localnet.sh validator)");
  }
  const scriptPort = input.env.E2E_RPC_PORT?.trim() || "8999";
  if (url.port !== scriptPort) {
    throw new ChainGateError(`E2E_WARP: CHAIN_RPC_URL port ${url.port || "(none)"} is not the e2e-localnet.sh RPC port ${scriptPort}`);
  }
  const script = path.join(input.frontDir, "scripts", "chain", "e2e-localnet.sh");
  return async (target, label) => {
    for (let attempt = 1; attempt <= MAX_WARPS; attempt++) {
      const now = await chainNow(input.rpc);
      if (now >= target) return;
      const info = await input.rpc.getEpochInfo({ commitment: "finalized" }).send();
      const slot = planWarpSlot({
        epoch: BigInt(info.epoch),
        slotIndex: BigInt(info.slotIndex),
        slotsInEpoch: BigInt(info.slotsInEpoch),
        absoluteSlot: BigInt(info.absoluteSlot),
        need: target - now + WARP_MARGIN_S,
      });
      input.journal.append({ event: "e2e-warp", label, attempt, target: target.toString(), now: now.toString(), slot: slot.toString() });
      input.log(`warp   ${label}: ${target - now} s of chain time short; restarting the validator at slot ${slot}`);
      const result = await runScript(script, ["warp", slot.toString()], input.frontDir, input.env, input.signal);
      if (result.status !== 0) {
        throw new ChainHaltError(`warp to slot ${slot} failed (${result.status ?? result.signal}): ${tail(result.stdout)} ${tail(result.stderr)}`);
      }
      input.log(`warp   ${tail(result.stdout, 1)}`);
    }
    const now = await chainNow(input.rpc);
    if (now < target) throw new ChainPlanError(`${label}: the chain clock is still ${target - now} s short after ${MAX_WARPS} warps`);
  };
}
