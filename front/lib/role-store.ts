// Role cache shared by every role consumer (Talas 3.1). Plain TypeScript, no
// React: lib/auth.ts subscribes through useSyncExternalStore and the node
// tests drive it directly.
//
// * Keys are `${network}|${wallet}`; a consumer only ever reads the entry of
//   its current key, so wallet A's result is never shown for wallet B.
// * An entry is reused for TTL_MS; concurrent callers share one in-flight read.
// * `invalidate()` bumps a generation counter and clears every entry. A read
//   stores its result only while its captured generation is still current
//   AND its promise is still the entry's promise; otherwise the result is
//   dropped (a read that started before a role change can never repopulate
//   the cache with the pre-change roles).
// * A failed read is evicted (the next request reads again) and its error is
//   published for the key until then.
// * An entry read without the (unpinned) KYC scan is upgraded by a request
//   that needs it; the lower-level read in flight is superseded.
import type { RoleSnapshot } from "@/lib/role-resolution";

export const ROLE_CACHE_TTL_MS = 30_000;

export type RoleStoreView<T> =
  /** Nothing requested for this key yet (or invalidated). */
  | { status: "idle" }
  | { status: "loading" }
  /** `refreshing`: a newer read (TTL refresh or KYC upgrade) is in flight. */
  | { status: "ready"; value: T; withKyc: boolean; refreshing: boolean }
  | { status: "error"; error: unknown };

type Entry<T> = {
  gen: number;
  at: number;
  withKyc: boolean;
  /** The read in flight for this entry, or null once settled. */
  promise: Promise<T> | null;
  /** Last successful value for this key in this generation. */
  snapshot?: T;
  snapshotWithKyc?: boolean;
};

export type RoleReader<T> = (withKyc: boolean) => Promise<T>;

export type RoleStore<T> = {
  /**
   * Makes sure a current value exists for `key`: reuses a fresh entry (or the
   * read in flight), otherwise starts `read`. Resolves once that read settled
   * (never rejects — errors are published through `getView`).
   */
  request(key: string, withKyc: boolean, read: RoleReader<T>, opts?: { force?: boolean }): Promise<void>;
  getView(key: string): RoleStoreView<T>;
  subscribe(listener: () => void): () => void;
  /** Drop every cached role and every read in flight (after a role change). */
  invalidate(): void;
  getGeneration(): number;
};

const IDLE = Object.freeze({ status: "idle" as const });
const LOADING = Object.freeze({ status: "loading" as const });

export function createRoleStore<T>(
  opts: { ttlMs?: number; now?: () => number } = {},
): RoleStore<T> {
  const ttlMs = opts.ttlMs ?? ROLE_CACHE_TTL_MS;
  const now = opts.now ?? Date.now;
  let generation = 0;
  const entries = new Map<string, Entry<T>>();
  const errors = new Map<string, unknown>();
  const views = new Map<string, RoleStoreView<T>>();
  const listeners = new Set<() => void>();

  function emit() {
    views.clear();
    for (const listener of [...listeners]) listener();
  }

  function reusable(e: Entry<T> | undefined, withKyc: boolean): e is Entry<T> {
    if (!e || e.gen !== generation) return false;
    if (withKyc && !e.withKyc) return false;
    if (e.promise) return true;
    return e.snapshot !== undefined && now() - e.at < ttlMs;
  }

  async function request(
    key: string,
    withKyc: boolean,
    read: RoleReader<T>,
    { force = false }: { force?: boolean } = {},
  ): Promise<void> {
    const existing = entries.get(key);
    if (!force && reusable(existing, withKyc)) {
      if (existing.promise) await existing.promise.then(noop, noop);
      return;
    }
    const gen = generation;
    let promise: Promise<T>;
    try {
      promise = read(withKyc);
    } catch (err) {
      promise = Promise.reject(err);
    }
    entries.set(key, {
      gen,
      at: now(),
      withKyc,
      promise,
      // Keep showing the previous value of this generation while refreshing.
      snapshot: existing?.gen === gen ? existing.snapshot : undefined,
      snapshotWithKyc: existing?.gen === gen ? existing.snapshotWithKyc : undefined,
    });
    errors.delete(key);
    emit();

    const current = () => gen === generation && entries.get(key)?.promise === promise;
    try {
      const value = await promise;
      if (!current()) return; // invalidated or superseded: drop the result
      entries.set(key, { gen, at: now(), withKyc, promise: null, snapshot: value, snapshotWithKyc: withKyc });
      emit();
    } catch (err) {
      if (!current()) return;
      entries.delete(key);
      errors.set(key, err);
      emit();
    }
  }

  function getView(key: string): RoleStoreView<T> {
    const cached = views.get(key);
    if (cached) return cached;
    let view: RoleStoreView<T>;
    const e = entries.get(key);
    if (e) {
      view =
        e.snapshot !== undefined
          ? {
              status: "ready",
              value: e.snapshot,
              withKyc: e.snapshotWithKyc ?? false,
              refreshing: e.promise !== null,
            }
          : LOADING;
    } else if (errors.has(key)) {
      view = { status: "error", error: errors.get(key) };
    } else {
      view = IDLE;
    }
    views.set(key, view);
    return view;
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function invalidate() {
    generation += 1;
    entries.clear();
    errors.clear();
    emit();
  }

  return { request, getView, subscribe, invalidate, getGeneration: () => generation };
}

function noop() {}

/** What the browser role read returns: the chain snapshot plus issuer detection. */
export type RoleReadResult = {
  snapshot: RoleSnapshot;
  isIssuer: boolean;
  isVerifiedIssuer: boolean;
};

/** The app-wide role cache (lib/auth.ts RoleProvider). */
export const roleStore: RoleStore<RoleReadResult> = createRoleStore<RoleReadResult>();

/**
 * Call after every transaction that changes an authority (rotation propose /
 * accept, Admin grant / revoke, platform init, blocklist bootstrap, KYC
 * registry actions, custody authority transfers, issuer rotation): every
 * consumer re-reads its roles instead of trusting the pre-change cache.
 */
export function invalidateRoles(): void {
  roleStore.invalidate();
}
