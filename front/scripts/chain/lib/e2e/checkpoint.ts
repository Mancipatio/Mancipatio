/**
 * Waiting for an action outside the runner (design-6.3 §A checkpoint C1: the
 * Super Admin signs in the browser). The wait may last many minutes on a
 * public RPC, so a transient RPC failure is retried with backoff instead of
 * failing the run; an abort is an abort, and a timeout is "not yet" (the
 * group returns "awaiting" and a re-run resumes).
 */
import { ChainAbortError, ChainRpcError } from "../safety";

export const CHECKPOINT_MAX_TRANSIENT = 5;

export async function waitForCheckpoint(input: {
  check: () => Promise<boolean>;
  waitMs: number;
  sleep: (ms: number) => Promise<void>;
  signal: AbortSignal;
  pollMs?: number;
  backoffMs?: number;
  /** Wall clock (injectable for tests). */
  now?: () => number;
}): Promise<boolean> {
  const now = input.now ?? Date.now;
  const pollMs = input.pollMs ?? 20_000;
  const backoffMs = input.backoffMs ?? 2_000;
  const deadline = now() + input.waitMs;
  let failures = 0;
  while (now() < deadline) {
    await input.sleep(failures ? backoffMs * 2 ** (failures - 1) : pollMs);
    if (input.signal.aborted) throw new ChainAbortError();
    try {
      if (await input.check()) return true;
      failures = 0;
    } catch (error) {
      if (input.signal.aborted) throw new ChainAbortError();
      if (!(error instanceof ChainRpcError) || failures >= CHECKPOINT_MAX_TRANSIENT) throw error;
      failures++;
    }
  }
  return false;
}
