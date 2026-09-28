/**
 * The chain's clock (design-6.3 §D): every e2e timestamp is the Clock
 * sysvar's `unix_timestamp` plus a margin, never the local time, and a wait
 * polls that same clock.
 */
import { fetchChainTime } from "../accounts";
import type { ChainRpc } from "../rpc";
import { ChainAbortError, ChainPlanError } from "../safety";

export async function chainNow(rpc: ChainRpc): Promise<bigint> {
  const now = await fetchChainTime(rpc, "confirmed");
  if (now === null) throw new ChainPlanError("The Clock sysvar is unreadable");
  return now;
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
