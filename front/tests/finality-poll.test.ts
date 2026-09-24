// lib/finality-poll and lib/latest-load (Talas 3.1 review): the bootstrap /
// rotation panels re-read until a just-sent init is visible at `finalized`,
// and wallet-keyed loads never show a stale or another wallet's result.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FINALITY_POLL_ATTEMPTS, FINALITY_POLL_INTERVAL_MS, startFinalityPoll } from "@/lib/finality-poll";
import { createLatestGate, valueForWallet } from "@/lib/latest-load";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("startFinalityPoll", () => {
  it("polls every interval until the read sees the account, then stops", async () => {
    let finalized = false;
    const poll = vi.fn(async () => finalized);
    startFinalityPoll(poll);
    expect(poll).not.toHaveBeenCalled(); // the caller already read once
    await vi.advanceTimersByTimeAsync(FINALITY_POLL_INTERVAL_MS);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FINALITY_POLL_INTERVAL_MS);
    expect(poll).toHaveBeenCalledTimes(2);
    finalized = true;
    await vi.advanceTimersByTimeAsync(FINALITY_POLL_INTERVAL_MS);
    expect(poll).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(FINALITY_POLL_INTERVAL_MS * 5);
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it("gives up after the attempts (a failed read counts as not yet) and says so once", async () => {
    const onGiveUp = vi.fn();
    const poll = vi.fn(async () => {
      throw new Error("rpc down");
    });
    startFinalityPoll(poll, { onGiveUp });
    await vi.advanceTimersByTimeAsync(FINALITY_POLL_INTERVAL_MS * (FINALITY_POLL_ATTEMPTS + 3));
    expect(poll).toHaveBeenCalledTimes(FINALITY_POLL_ATTEMPTS);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
  });

  it("stop (effect cleanup) cancels the pending poll", async () => {
    const poll = vi.fn(async () => false);
    const stop = startFinalityPoll(poll);
    await vi.advanceTimersByTimeAsync(FINALITY_POLL_INTERVAL_MS);
    stop();
    await vi.advanceTimersByTimeAsync(FINALITY_POLL_INTERVAL_MS * 3);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("never overlaps: the next wait starts after a slow read settled", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const poll = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, FINALITY_POLL_INTERVAL_MS * 3));
      inFlight -= 1;
      return false;
    });
    startFinalityPoll(poll, { attempts: 3 });
    await vi.advanceTimersByTimeAsync(FINALITY_POLL_INTERVAL_MS * 20);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(1);
  });
});

describe("latest-load guards (pending roles panel)", () => {
  it("only the most recently started load may commit", () => {
    const gate = createLatestGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(first()).toBe(false); // a slower, older load finishing last is dropped
    expect(second()).toBe(true);
  });

  it("a result loaded for one wallet is never shown for another", () => {
    const loaded = { wallet: "walletA", value: ["A's pending role"] };
    expect(valueForWallet(loaded, "walletA")).toEqual(["A's pending role"]);
    expect(valueForWallet(loaded, "walletB")).toBeNull();
    expect(valueForWallet(loaded, null)).toBeNull();
    expect(valueForWallet(null, "walletA")).toBeNull();
  });
});
