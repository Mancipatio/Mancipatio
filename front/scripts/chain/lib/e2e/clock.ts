/**
 * The chain's clock (design-6.3 §D): every e2e timestamp is the Clock
 * sysvar's `unix_timestamp` plus a margin, never the local time, and a wait
 * polls that same clock.
 */
import { address } from "@solana/kit";
import type { ChainRpc } from "../rpc";
import { ChainAbortError, ChainPlanError } from "../safety";

const CLOCK_SYSVAR = address("SysvarC1ock11111111111111111111111111111111");
/** slot u64, epoch_start_timestamp i64, epoch u64, leader_schedule_epoch u64, unix_timestamp i64. */
const UNIX_TIMESTAMP_OFFSET = 32;

export async function chainNow(rpc: ChainRpc): Promise<bigint> {
  const { value } = await rpc
    .getAccountInfo(CLOCK_SYSVAR, { encoding: "base64", commitment: "confirmed" })
    .send();
  if (!value) throw new ChainPlanError("The Clock sysvar is unreadable");
  const data = Buffer.from(value.data[0], "base64");
  if (data.length < UNIX_TIMESTAMP_OFFSET + 8) throw new ChainPlanError("The Clock sysvar is too short");
  return data.readBigInt64LE(UNIX_TIMESTAMP_OFFSET);
}

/** Polls the chain clock until it reaches `target` (seconds). */
export async function waitForChainTime(input: {
  rpc: ChainRpc;
  target: bigint;
  sleep: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  pollMs?: number;
  log?: (line: string) => void;
  label: string;
}): Promise<void> {
  const pollMs = input.pollMs ?? 10_000;
  let announced = false;
  for (;;) {
    if (input.signal?.aborted) throw new ChainAbortError();
    const now = await chainNow(input.rpc);
    if (now >= input.target) return;
    if (!announced) {
      input.log?.(`wait   ${input.label}: ${input.target - now} s of chain time`);
      announced = true;
    }
    await input.sleep(pollMs);
  }
}
