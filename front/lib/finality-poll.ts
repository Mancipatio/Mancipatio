// Re-read until a just-sent change is visible at `finalized` (Talas 3.1).
// The bootstrap and rotation panels read authorities at `finalized` (what the
// builders and the server gates trust), which trails `confirmed` by ~15–30 s:
// right after an init or a proposal the panel would otherwise keep showing
// the pre-change state until the user clicks Refresh.

export const FINALITY_POLL_INTERVAL_MS = 5_000;
/** 12 × 5 s = one minute, well past the usual finalization lag. */
export const FINALITY_POLL_ATTEMPTS = 12;

type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
};

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof globalThis.setTimeout>),
};

/**
 * Calls `poll` every `intervalMs` (never overlapping: the next wait starts
 * after the previous poll settled) until it resolves `true`, `attempts` ran
 * out or the returned stop function is called. A rejected poll counts as
 * "not yet". `onGiveUp` runs once when the attempts ran out.
 */
export function startFinalityPoll(
  poll: () => Promise<boolean>,
  opts: { intervalMs?: number; attempts?: number; onGiveUp?: () => void } = {},
  timers: Timers = defaultTimers,
): () => void {
  const intervalMs = opts.intervalMs ?? FINALITY_POLL_INTERVAL_MS;
  const attempts = opts.attempts ?? FINALITY_POLL_ATTEMPTS;
  let stopped = false;
  let handle: unknown = null;
  let done = 0;

  const schedule = () => {
    handle = timers.setTimeout(() => void tick(), intervalMs);
  };
  const tick = async () => {
    if (stopped) return;
    done += 1;
    let ok = false;
    try {
      ok = await poll();
    } catch {
      ok = false;
    }
    if (stopped || ok) return;
    if (done >= attempts) {
      opts.onGiveUp?.();
      return;
    }
    schedule();
  };

  schedule();
  return () => {
    stopped = true;
    if (handle !== null) timers.clearTimeout(handle);
  };
}
