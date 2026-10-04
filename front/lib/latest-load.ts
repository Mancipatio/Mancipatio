// Guards for async loads keyed by the connected wallet (Talas 3.1 §1.2,
// invariant 7): one wallet's result is never shown for another, and a slower
// load that started earlier never overwrites a newer one.

/** Only the most recently started load may commit its result. */
export function createLatestGate(): { begin(): () => boolean } {
  let seq = 0;
  return {
    begin() {
      const id = ++seq;
      return () => id === seq;
    },
  };
}

/**
 * createLatestGate for a load that can stop early: begin() aborts the
 * previous load's signal and hands out a fresh one, and abort() (an unmount)
 * aborts the current one. A load commits only while its signal is not
 * aborted, and passes it on (lib/rpc-retry withRpcReadRetry), so a superseded
 * or abandoned load stops retrying and waiting.
 */
export function createAbortableLatest(): { begin(): AbortSignal; abort(): void } {
  let controller: AbortController | null = null;
  return {
    begin() {
      controller?.abort();
      controller = new AbortController();
      return controller.signal;
    },
    abort() {
      controller?.abort();
    },
  };
}

/** A loaded value tagged with the wallet it was loaded for. */
export type ForWallet<T> = { wallet: string; value: T };

/** The value only when it was loaded for the wallet connected now. */
export function valueForWallet<T>(loaded: ForWallet<T> | null, wallet: string | null): T | null {
  return loaded !== null && wallet !== null && loaded.wallet === wallet ? loaded.value : null;
}
