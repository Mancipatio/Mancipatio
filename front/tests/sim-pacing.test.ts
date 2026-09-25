// The simulator's global limiter (scripts/sim/lib/pacing.ts) on a fake
// clock: the owner's 25.9. limits and the circuit breakers.
import { describe, expect, it } from "vitest";
import { BREAKERS, Limiter, type Clock, type PaceClass } from "@/scripts/sim/lib/pacing";
import { SimStopError } from "@/scripts/sim/lib/safety";

function fakeClock(): Clock & { t: number } {
  const clock = {
    t: 0,
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += ms;
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  return clock;
}

/** Grant times (ms) of `count` sequential acquisitions of `classes`. */
async function grants(limiter: Limiter, clock: { t: number }, classes: PaceClass[], count: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const release = await limiter.acquire(classes);
    out.push(clock.t);
    release();
  }
  return out;
}

describe("pacing limits", () => {
  it("spaces signed writes 8 s apart", async () => {
    const clock = fakeClock();
    const at = await grants(new Limiter({ clock }), clock, ["write"], 4);
    expect(at).toEqual([0, 8_000, 16_000, 24_000]);
  });

  it("allows at most 10 uploads per minute", async () => {
    const clock = fakeClock();
    const at = await grants(new Limiter({ clock }), clock, ["upload"], 21);
    expect(at.slice(0, 10).every((t) => t === 0)).toBe(true);
    expect(at[10]).toBeGreaterThanOrEqual(60_000);
    expect(at[20]).toBeGreaterThanOrEqual(120_000);
    for (let i = 10; i < at.length; i++) expect(at[i] - at[i - 10]).toBeGreaterThanOrEqual(60_000);
  });

  it("allows at most 5 verification.submit per minute, still 8 s apart", async () => {
    const clock = fakeClock();
    const at = await grants(new Limiter({ clock }), clock, ["write", "verify"], 6);
    expect(at.slice(0, 5)).toEqual([0, 8_000, 16_000, 24_000, 32_000]);
    expect(at[5]).toBeGreaterThanOrEqual(60_000);
  });

  it("allows at most 15 token/status reads per minute", async () => {
    const clock = fakeClock();
    const at = await grants(new Limiter({ clock }), clock, ["read"], 16);
    expect(at[14]).toBe(0);
    expect(at[15]).toBeGreaterThanOrEqual(60_000);
  });

  it("allows at most 3 transactions per minute and one in flight", async () => {
    const clock = fakeClock();
    const limiter = new Limiter({ clock });
    const at = await grants(limiter, clock, ["tx"], 4);
    expect(at.slice(0, 3)).toEqual([0, 0, 0]);
    expect(at[3]).toBeGreaterThanOrEqual(60_000);
    const unlock = await limiter.lockTx();
    let second = false;
    const pending = limiter.lockTx().then((u) => {
      second = true;
      u();
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(second).toBe(false);
    unlock();
    await pending;
    expect(second).toBe(true);
  });

  it("keeps at most 2 HTTP requests in flight", async () => {
    const clock = fakeClock();
    const limiter = new Limiter({ clock });
    const a = await limiter.acquire(["read"]);
    const b = await limiter.acquire(["read"]);
    let third = false;
    const pending = limiter.acquire(["read"]).then((release) => {
      third = true;
      return release;
    });
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(limiter.httpInFlight).toBe(2);
    expect(third).toBe(false);
    a();
    const c = await pending;
    expect(third).toBe(true);
    expect(limiter.httpInFlight).toBe(2);
    b();
    c();
    expect(limiter.httpInFlight).toBe(0);
  });
});

describe("circuit breakers", () => {
  it("stops on a 503 maintenance answer", async () => {
    const limiter = new Limiter({ clock: fakeClock() });
    limiter.noteHttp(503, "maintenance");
    expect(limiter.stopReason).toMatch(/maintenance/);
    await expect(limiter.acquire(["read"])).rejects.toBeInstanceOf(SimStopError);
  });

  it("stops after 5 consecutive 5xx or network failures, and a success resets the count", () => {
    const limiter = new Limiter({ clock: fakeClock() });
    for (let i = 0; i < 4; i++) limiter.noteHttp(500);
    limiter.noteHttp(200);
    for (let i = 0; i < 4; i++) limiter.noteHttp(i % 2 ? 0 : 502);
    expect(limiter.stopReason).toBeNull();
    limiter.noteHttp(503);
    expect(limiter.stopReason).toMatch(/5 consecutive/);
  });

  it("pauses the chain 120 s after two RPC 429s within 60 s", async () => {
    const clock = fakeClock();
    const limiter = new Limiter({ clock });
    limiter.noteRpc429();
    clock.t += 61_000;
    limiter.noteRpc429(); // the first one left the window
    expect(limiter.rpcPauseMs()).toBe(0);
    clock.t += 1_000;
    limiter.noteRpc429();
    expect(limiter.rpcPauseMs()).toBe(BREAKERS.rpcPauseMs);
    const start = clock.t;
    await limiter.rpcReady();
    expect(clock.t - start).toBeGreaterThanOrEqual(BREAKERS.rpcPauseMs);
    const release = await limiter.acquire(["tx"]);
    release();
  });

  it("holds HTTP for 60 s after the site answers 429", async () => {
    const clock = fakeClock();
    const limiter = new Limiter({ clock });
    limiter.noteHttp(429);
    const release = await limiter.acquire(["read"]);
    expect(clock.t).toBeGreaterThanOrEqual(BREAKERS.http429PauseMs);
    release();
  });

  it("stops when the STOP switch reports a reason", async () => {
    const limiter = new Limiter({ clock: fakeClock(), isStopped: () => "STOP file present" });
    await expect(limiter.acquire(["write"])).rejects.toThrow(/STOP file present/);
  });
});
