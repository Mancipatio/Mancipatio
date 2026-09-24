// lib/role-store (Talas 3.1 §1.2): the role cache's race guards. Reads are
// controllable deferreds, so each test decides exactly when a read settles.
import { describe, expect, it } from "vitest";
import { createRoleStore } from "@/lib/role-store";

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A reader whose every call returns a fresh deferred the test settles. */
function controllableReader<T>() {
  const calls: { withKyc: boolean; d: Deferred<T> }[] = [];
  const read = (withKyc: boolean) => {
    const d = deferred<T>();
    calls.push({ withKyc, d });
    return d.promise;
  };
  return { read, calls };
}

const A = "devnet|walletA";
const B = "devnet|walletB";

describe("role store", () => {
  it("shares one in-flight read between concurrent callers", async () => {
    const store = createRoleStore<string>();
    const r = controllableReader<string>();
    const p1 = store.request(A, false, r.read);
    const p2 = store.request(A, false, r.read);
    expect(r.calls).toHaveLength(1);
    expect(store.getView(A)).toEqual({ status: "loading" });
    r.calls[0].d.resolve("roles-A");
    await Promise.all([p1, p2]);
    expect(store.getView(A)).toMatchObject({ status: "ready", value: "roles-A", withKyc: false });
    // Fresh: reused without another read.
    await store.request(A, false, r.read);
    expect(r.calls).toHaveLength(1);
  });

  it("re-reads after the TTL, showing the previous value meanwhile", async () => {
    let now = 1_000;
    const store = createRoleStore<string>({ ttlMs: 30_000, now: () => now });
    const r = controllableReader<string>();
    const first = store.request(A, false, r.read);
    r.calls[0].d.resolve("v1");
    await first;
    now += 30_001;
    const second = store.request(A, false, r.read);
    expect(r.calls).toHaveLength(2);
    expect(store.getView(A)).toMatchObject({ status: "ready", value: "v1", refreshing: true });
    r.calls[1].d.resolve("v2");
    await second;
    expect(store.getView(A)).toMatchObject({ status: "ready", value: "v2", refreshing: false });
  });

  it("an invalidate during an in-flight read keeps the stale result out", async () => {
    const store = createRoleStore<string>();
    const r = controllableReader<string>();
    const stale = store.request(A, false, r.read);
    const genBefore = store.getGeneration();
    store.invalidate();
    expect(store.getGeneration()).toBe(genBefore + 1);
    expect(store.getView(A)).toEqual({ status: "idle" });
    // The pre-change read lands late: it must not repopulate the cache.
    r.calls[0].d.resolve("pre-rotation roles");
    await stale;
    expect(store.getView(A)).toEqual({ status: "idle" });
    // The next request reads again and stores the fresh value.
    const fresh = store.request(A, false, r.read);
    expect(r.calls).toHaveLength(2);
    r.calls[1].d.resolve("post-rotation roles");
    await fresh;
    expect(store.getView(A)).toMatchObject({ status: "ready", value: "post-rotation roles" });
  });

  it("a stale read that fails after an invalidate publishes no error", async () => {
    const store = createRoleStore<string>();
    const r = controllableReader<string>();
    const p = store.request(A, false, r.read);
    store.invalidate();
    r.calls[0].d.reject(new Error("late failure"));
    await p;
    expect(store.getView(A)).toEqual({ status: "idle" });
  });

  it("a wallet switch mid-read never shows A's result for B", async () => {
    const store = createRoleStore<string>();
    const r = controllableReader<string>();
    const pa = store.request(A, false, r.read);
    const pb = store.request(B, false, r.read);
    expect(r.calls).toHaveLength(2);
    r.calls[0].d.resolve("roles-A");
    await pa;
    expect(store.getView(B)).toEqual({ status: "loading" });
    r.calls[1].d.resolve("roles-B");
    await pb;
    expect(store.getView(B)).toMatchObject({ status: "ready", value: "roles-B" });
    expect(store.getView(A)).toMatchObject({ status: "ready", value: "roles-A" });
  });

  it("a failure is evicted: the error is published, the next request reads again", async () => {
    const store = createRoleStore<string>();
    const r = controllableReader<string>();
    const p = store.request(A, false, r.read);
    const boom = new Error("rpc down");
    r.calls[0].d.reject(boom);
    await p; // never rejects
    expect(store.getView(A)).toEqual({ status: "error", error: boom });
    const retry = store.request(A, false, r.read);
    expect(r.calls).toHaveLength(2);
    expect(store.getView(A)).toEqual({ status: "loading" });
    r.calls[1].d.resolve("recovered");
    await retry;
    expect(store.getView(A)).toMatchObject({ status: "ready", value: "recovered" });
  });

  it("a synchronous reader throw is treated like a failed read", async () => {
    const store = createRoleStore<string>();
    await store.request(A, false, () => {
      throw new Error("bad setup");
    });
    expect(store.getView(A)).toMatchObject({ status: "error" });
  });

  it("an entry read without KYC is upgraded by a request that needs it", async () => {
    const store = createRoleStore<string>();
    const r = controllableReader<string>();
    const plain = store.request(A, false, r.read);
    r.calls[0].d.resolve("no-kyc");
    await plain;
    // A non-KYC request is satisfied by the plain entry...
    await store.request(A, false, r.read);
    expect(r.calls).toHaveLength(1);
    // ...a KYC request is not.
    const upgrade = store.request(A, true, r.read);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1].withKyc).toBe(true);
    expect(store.getView(A)).toMatchObject({ status: "ready", value: "no-kyc", withKyc: false, refreshing: true });
    r.calls[1].d.resolve("with-kyc");
    await upgrade;
    expect(store.getView(A)).toMatchObject({ status: "ready", value: "with-kyc", withKyc: true });
    // A KYC entry also satisfies later non-KYC requests.
    await store.request(A, false, r.read);
    expect(r.calls).toHaveLength(2);
  });

  it("an upgrade supersedes a lower-level read still in flight", async () => {
    const store = createRoleStore<string>();
    const r = controllableReader<string>();
    const plain = store.request(A, false, r.read);
    const upgrade = store.request(A, true, r.read);
    expect(r.calls).toHaveLength(2);
    r.calls[1].d.resolve("with-kyc");
    await upgrade;
    // The superseded non-KYC read lands last and is dropped.
    r.calls[0].d.resolve("no-kyc");
    await plain;
    expect(store.getView(A)).toMatchObject({ status: "ready", value: "with-kyc", withKyc: true });
  });

  it("force re-reads a fresh entry; listeners hear every change; views are stable", async () => {
    const store = createRoleStore<string>();
    const r = controllableReader<string>();
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });
    const p = store.request(A, false, r.read);
    r.calls[0].d.resolve("v1");
    await p;
    const view = store.getView(A);
    expect(store.getView(A)).toBe(view); // same object until something changes
    const forced = store.request(A, false, r.read, { force: true });
    expect(r.calls).toHaveLength(2);
    r.calls[1].d.resolve("v2");
    await forced;
    expect(store.getView(A)).not.toBe(view);
    expect(notified).toBe(4); // start, settle, start, settle
    unsubscribe();
    store.invalidate();
    expect(notified).toBe(4);
  });
});
