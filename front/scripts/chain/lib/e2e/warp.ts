/**
 * Localnet clock warp (design-6.3 §D): the 7-day recoveries, the 48-hour
 * grants and rotations, the 30-day KYC grace and three missed payout months
 * cannot be waited out, so on localnet the run restarts its own validator
 * with `--warp-slot` (scripts/chain/e2e-localnet.sh warp). Opt-in
 * (E2E_WARP=1), localnet only, and only against the validator that script
 * runs (its RPC port must be CHAIN_RPC_URL's); anything else gets no warp and
 * the time-bound steps are recorded as not run.
 *
 * The Clock sysvar across a warp (Agave 4.2.2, measured on this validator,
 * so the loop measures instead of predicting):
 *
 * - a warp INSIDE the current epoch jumps the clock (about 0.4 s per slot
 *   the first time, about 0.19 s per slot once the clock runs ahead of the
 *   wall clock), and the clock then usually STOPS: the next votes carry
 *   wall-clock time, far behind it, until its drift floor catches up (hours
 *   for a day's jump);
 * - a warp to an epoch past the leader-schedule epoch has no stakes to
 *   estimate a time from: the clock keeps its value, which becomes the new
 *   epoch's start, and it runs again from there (a "reset", no jump).
 *
 * So one move is: while short and moving, a jump inside the epoch sized
 * from the rate the last jump showed; once there (or stopped), a reset.
 * Done means the target is reached AND the clock moves (the groups wait
 * short gaps out in real time). The clock never goes back.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import type { Address } from "@solana/kit";
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
/** Epochs a reset skips: past the leader-schedule epoch (current + 1), so no vote estimate applies. */
const RESET_EPOCHS = BigInt(3);
const MAX_WARPS = 12;
/** Clock seconds per slot, in micro-units (bigint arithmetic). */
const MICRO = BigInt(1_000_000);
/** The first jump's assumed rate: the lower one measured, so a first guess overshoots at most about 2×. */
export const DEFAULT_RATE_MICRO = BigInt(190_000);
const MIN_RATE_MICRO = BigInt(50_000);
/** How long the loop watches the clock to see whether it moves. */
const MOVING_PROBE_MS = 12_000;

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - BigInt(1)) / b;
}

/** The Clock sysvar fields a warp plans with. */
export type ClockState = { slot: bigint; epochStartTimestamp: bigint; epoch: bigint; unixTimestamp: bigint };

export function decodeClock(data: Uint8Array): ClockState {
  if (data.length < 40) throw new ChainPlanError("The Clock sysvar is truncated");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    slot: view.getBigUint64(0, true),
    epochStartTimestamp: view.getBigInt64(8, true),
    epoch: view.getBigUint64(16, true),
    unixTimestamp: view.getBigInt64(32, true),
  };
}

export type WarpPlan = { kind: "done" } | { kind: "jump"; slot: bigint } | { kind: "reset"; slot: bigint };

/**
 * The next warp towards `target` (pure; see the header): done once the clock
 * is there and moving; a reset when it has stopped (or the epoch has no room
 * left); else a jump of (target + margin − now) / rate slots, at most to the
 * epoch's end (a longer move takes several rounds).
 */
export function planWarp(input: { clock: ClockState; moving: boolean; schedule: EpochSchedule; target: bigint; rateMicro: bigint }): WarpPlan {
  const { clock, schedule } = input;
  if (schedule.warmup && clock.slot < schedule.firstNormalSlot) {
    throw new ChainPlanError("A warp needs a validator without warmup epochs (e2e-localnet.sh genesis)");
  }
  const length = schedule.slotsPerEpoch;
  const first = schedule.firstNormalSlot + (clock.epoch - schedule.firstNormalEpoch) * length;
  const reset: WarpPlan = { kind: "reset", slot: first + RESET_EPOCHS * length };
  if (!input.moving) return reset;
  if (clock.unixTimestamp >= input.target) return { kind: "done" };
  const rate = input.rateMicro > MIN_RATE_MICRO ? input.rateMicro : MIN_RATE_MICRO;
  const jump = clock.slot + ceilDiv((input.target + WARP_MARGIN_S - clock.unixTimestamp) * MICRO, rate);
  const slot = jump > clock.slot + SLOT_GUARD ? jump : clock.slot + SLOT_GUARD;
  const last = first + length - SLOT_GUARD;
  if (slot < last) return { kind: "jump", slot };
  // Too far for this epoch: as far as it goes (the next rounds reset and go on), or a reset at its end.
  return last > clock.slot + SLOT_GUARD ? { kind: "jump", slot: last } : reset;
}

/** The rate a jump showed (micro-seconds of clock per slot), or null when it moved nothing. */
export function observedRate(before: ClockState, after: ClockState): bigint | null {
  if (after.slot <= before.slot || after.unixTimestamp <= before.unixTimestamp) return null;
  return ((after.unixTimestamp - before.unixTimestamp) * MICRO) / (after.slot - before.slot);
}

const EPOCH_SCHEDULE_SYSVAR = "SysvarEpochSchedu1e111111111111111111111111" as Address;

export type EpochSchedule = { slotsPerEpoch: bigint; warmup: boolean; firstNormalEpoch: bigint; firstNormalSlot: bigint };

/** The EpochSchedule sysvar: slots_per_epoch, leader_schedule_slot_offset, warmup, first_normal_epoch, first_normal_slot. */
export function decodeEpochSchedule(data: Uint8Array): EpochSchedule {
  if (data.length < 33) throw new ChainPlanError("The EpochSchedule sysvar is truncated");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    slotsPerEpoch: view.getBigUint64(0, true),
    warmup: data[16] !== 0,
    firstNormalEpoch: view.getBigUint64(17, true),
    firstNormalSlot: view.getBigUint64(25, true),
  };
}

const CLOCK_SYSVAR = "SysvarC1ock11111111111111111111111111111111" as Address;

async function readSysvar(rpc: ChainRpc, address: Address, name: string, commitment: "finalized" | "confirmed"): Promise<Uint8Array> {
  const { value } = await rpc.getAccountInfo(address, { encoding: "base64", commitment }).send();
  if (!value) throw new ChainPlanError(`The ${name} sysvar is unreadable`);
  return new Uint8Array(Buffer.from((value as { data: [string, string] }).data[0], "base64"));
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
  /** The moving-clock probe's wait (tests). */
  sleep?: (ms: number) => Promise<void>;
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
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let rateMicro = DEFAULT_RATE_MICRO;
  const readClock = async (commitment: "finalized" | "confirmed") =>
    decodeClock(await readSysvar(input.rpc, CLOCK_SYSVAR, "Clock", commitment));
  return async (target, label) => {
    const schedule = decodeEpochSchedule(await readSysvar(input.rpc, EPOCH_SCHEDULE_SYSVAR, "EpochSchedule", "finalized"));
    for (let attempt = 1; attempt <= MAX_WARPS; attempt++) {
      // Moving: the confirmed clock advances over a few seconds.
      const first = await readClock("confirmed");
      await sleep(MOVING_PROBE_MS);
      const moving = (await readClock("confirmed")).unixTimestamp > first.unixTimestamp;
      // The finalized Clock: the state the restart resumes from.
      const clock = await readClock("finalized");
      const plan = planWarp({ clock, moving, schedule, target, rateMicro });
      if (plan.kind === "done") return;
      input.journal.append({
        event: "e2e-warp",
        label,
        attempt,
        kind: plan.kind,
        target: target.toString(),
        now: clock.unixTimestamp.toString(),
        moving,
        rateMicro: rateMicro.toString(),
        fromSlot: clock.slot.toString(),
        slot: plan.slot.toString(),
      });
      input.log(
        plan.kind === "jump"
          ? `warp   ${label}: ${target - clock.unixTimestamp} s of chain time short; jumping to slot ${plan.slot}`
          : `warp   ${label}: ${moving ? "the jump does not fit this epoch" : "the clock stopped"}; resetting it at slot ${plan.slot}`,
      );
      const result = await runScript(script, ["warp", plan.slot.toString()], input.frontDir, input.env, input.signal);
      if (result.status !== 0) {
        throw new ChainHaltError(`warp to slot ${plan.slot} failed (${result.status ?? result.signal}): ${tail(result.stdout)} ${tail(result.stderr)}`);
      }
      input.log(`warp   ${tail(result.stdout, 1)}`);
      if (plan.kind === "jump") {
        const rate = observedRate(clock, await readClock("finalized"));
        if (rate !== null) rateMicro = rate;
      }
    }
    const now = await chainNow(input.rpc);
    if (now < target) throw new ChainPlanError(`${label}: the chain clock is still ${target - now} s short after ${MAX_WARPS} warps`);
    throw new ChainPlanError(`${label}: the chain clock did not start moving again after ${MAX_WARPS} warps`);
  };
}
