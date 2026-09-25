/**
 * One global pacing limiter for the whole run (design-sim §4, owner
 * decisions 25.9.). The simulator shares the owner's IP with the owner's
 * browser, so every limit is half (or less) of the site's per-IP window:
 *
 * - at most 2 HTTP requests in flight;
 * - one signed write every 8 s;
 * - uploads ≤ 10/min, verification.submit ≤ 5/min, token/status reads ≤ 15/min;
 * - program transactions ≤ 3/min with one in flight (CHAIN_RPS=1 is the
 *   RPC token bucket in scripts/chain/lib/rpc.ts);
 * - transfer probes (simulated, never sent) ≤ 6/min, outside the tx lock.
 *
 * Circuit breakers: a 503 `maintenance` stops the run, 5 consecutive 5xx (or
 * network failures) stop it, two RPC 429s within 60 s pause the chain for
 * 120 s, and an HTTP 429 from the site pauses HTTP for 60 s.
 *
 * Time is injected (`now`, `sleep`, and for a virtual clock the scheduler's
 * `worker`s) so the tests drive a fake clock.
 */
import { PACE } from "./constants";
import { SimStopError } from "./safety";

export type PaceClass = "write" | "verify" | "upload" | "read" | "tx" | "probe";

export type PaceRules = {
  httpConcurrency: number;
  minIntervalMs: Partial<Record<PaceClass, number>>;
  window: Partial<Record<PaceClass, { max: number; ms: number }>>;
};

export const DEFAULT_RULES: PaceRules = {
  httpConcurrency: PACE.httpConcurrency,
  minIntervalMs: { write: PACE.writeIntervalMs },
  window: {
    verify: { max: PACE.verificationPerMin, ms: 60_000 },
    upload: { max: PACE.uploadsPerMin, ms: 60_000 },
    read: { max: PACE.readsPerMin, ms: 60_000 },
    tx: { max: PACE.txPerMin, ms: 60_000 },
    probe: { max: PACE.probesPerMin, ms: 60_000 },
  },
};

/** Classes that go to the RPC (held by the RPC breaker), not to the site. */
function chainClass(classes: readonly PaceClass[]): boolean {
  return classes.includes("tx") || classes.includes("probe");
}

export const BREAKERS = {
  consecutive5xx: 5,
  rpc429Window: 60_000,
  rpc429Count: 2,
  rpcPauseMs: 120_000,
  http429PauseMs: 60_000,
} as const;

export type Clock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /**
   * Runs one of the scheduler's concurrent workers. A virtual clock (the
   * tests') needs to know them: it moves time only while every worker is
   * asleep on it, so a step's real awaits (WebCrypto signing, verification and
   * PDA digests) take no simulated time and cannot let another worker's sleep
   * run ahead. The real clock has none: the worker just runs.
   */
  worker?: <T>(run: () => Promise<T>) => Promise<T>;
};

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class Limiter {
  private readonly rules: PaceRules;
  private readonly clock: Clock;
  private readonly last = new Map<PaceClass, number>();
  private readonly history = new Map<PaceClass, number[]>();
  private inFlight = 0;
  private txBusy = false;
  private fails = 0;
  private rpc429: number[] = [];
  private httpPausedUntil = 0;
  private rpcPausedUntil = 0;
  private stopped: string | null = null;
  /** Grants per class (the plan's budget check and the tests read these). */
  readonly granted: Record<PaceClass, number> = { write: 0, verify: 0, upload: 0, read: 0, tx: 0, probe: 0 };

  /** The STOP file / SIGINT switch, asked before every grant. */
  private readonly externalStop: () => string | null;

  constructor(options: { rules?: PaceRules; clock?: Clock; isStopped?: () => string | null } = {}) {
    this.rules = options.rules ?? DEFAULT_RULES;
    this.clock = options.clock ?? realClock;
    this.externalStop = options.isStopped ?? (() => null);
  }

  get stopReason(): string | null {
    return this.stopped;
  }

  stop(reason: string): void {
    this.stopped ??= reason;
  }

  private assertRunning(): void {
    if (this.stopped) throw new SimStopError(this.stopped);
  }

  /** Milliseconds until every class in `classes` allows one more grant (0 = now). */
  waitMs(classes: readonly PaceClass[]): number {
    const now = this.clock.now();
    let wait = 0;
    for (const cls of classes) {
      const interval = this.rules.minIntervalMs[cls];
      const last = this.last.get(cls);
      if (interval !== undefined && last !== undefined) wait = Math.max(wait, last + interval - now);
      const window = this.rules.window[cls];
      if (window) {
        const recent = (this.history.get(cls) ?? []).filter((t) => t > now - window.ms);
        this.history.set(cls, recent);
        if (recent.length >= window.max) wait = Math.max(wait, recent[recent.length - window.max] + window.ms - now);
      }
    }
    if (chainClass(classes)) wait = Math.max(wait, this.rpcPausedUntil - now);
    else wait = Math.max(wait, this.httpPausedUntil - now);
    return Math.max(0, wait);
  }

  private record(classes: readonly PaceClass[]): void {
    const now = this.clock.now();
    for (const cls of classes) {
      this.last.set(cls, now);
      const list = this.history.get(cls) ?? [];
      list.push(now);
      this.history.set(cls, list);
      this.granted[cls] += 1;
    }
  }

  /**
   * Waits for a slot. HTTP grants also take one of the in-flight slots; the
   * returned function releases it (call it in `finally`).
   */
  async acquire(classes: readonly PaceClass[], options: { http?: boolean } = {}): Promise<() => void> {
    const http = options.http ?? !chainClass(classes);
    for (;;) {
      const external = this.externalStop();
      if (external) this.stop(external);
      this.assertRunning();
      const wait = this.waitMs(classes);
      const slot = !http || this.inFlight < this.rules.httpConcurrency;
      if (wait === 0 && slot) break;
      await this.clock.sleep(wait > 0 ? Math.min(wait, 1_000) : 25);
    }
    this.record(classes);
    if (!http) return () => {};
    this.inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
    };
  }

  /** One transaction in flight: held from signing until finality. */
  async lockTx(): Promise<() => void> {
    while (this.txBusy) {
      this.assertRunning();
      await this.clock.sleep(250);
    }
    this.txBusy = true;
    return () => {
      this.txBusy = false;
    };
  }

  get httpInFlight(): number {
    return this.inFlight;
  }

  /** Feeds the HTTP breakers. `status` 0 means the request never got a response. */
  noteHttp(status: number, code: string | null = null): void {
    if (status === 503 && code === "maintenance") {
      this.stop("the site is in maintenance (503 maintenance); do not retry in a loop");
      return;
    }
    if (status === 0 || status >= 500) {
      this.fails += 1;
      if (this.fails >= BREAKERS.consecutive5xx) this.stop(`${this.fails} consecutive 5xx or network failures`);
      return;
    }
    this.fails = 0;
    if (status === 429) this.httpPausedUntil = this.clock.now() + BREAKERS.http429PauseMs;
  }

  /** Two RPC 429s within 60 s pause every chain call for 120 s. */
  noteRpc429(): void {
    const now = this.clock.now();
    this.rpc429 = this.rpc429.filter((t) => t > now - BREAKERS.rpc429Window);
    this.rpc429.push(now);
    if (this.rpc429.length >= BREAKERS.rpc429Count) {
      this.rpcPausedUntil = now + BREAKERS.rpcPauseMs;
      this.rpc429 = [];
    }
  }

  rpcPauseMs(): number {
    return Math.max(0, this.rpcPausedUntil - this.clock.now());
  }

  /** Blocks while the RPC breaker is open (called before every RPC request). */
  async rpcReady(): Promise<void> {
    for (let wait = this.rpcPauseMs(); wait > 0; wait = this.rpcPauseMs()) {
      this.assertRunning();
      await this.clock.sleep(Math.min(wait, 1_000));
    }
  }
}
