// lib/rpc-retry: a chain read refused for a moment (HTTP 429, a 5xx, no
// response) is retried at most three times after ~0.5, 1 and 2 s with
// jitter; anything else, and the last failure, is thrown as it was. The
// tokenize checklist reads through it, so its "Could not read the token's
// state" notice shows only after the retries (mainnet, 2026-10-04).
import fs from "node:fs";
import path from "node:path";
import {
  SOLANA_ERROR__ACCOUNTS__ACCOUNT_NOT_FOUND,
  SOLANA_ERROR__JSON_RPC__INVALID_PARAMS,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SolanaError,
  address,
} from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import {
  RPC_READ_RETRY_DELAYS_MS,
  RPC_READ_RETRY_JITTER,
  isTransientRpcError,
  retryDelayMs,
  withRpcReadRetry,
} from "@/lib/rpc-retry";

const httpError = (statusCode: number) =>
  new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: "HTTP", statusCode });

/** A read that fails with `errors` in turn, then answers `value`. */
function flaky<T>(errors: unknown[], value: T) {
  let calls = 0;
  const read = vi.fn(async () => {
    const error = errors[calls++];
    if (error !== undefined) throw error;
    return value;
  });
  return read;
}

/** Records the waits instead of waiting. */
function sleeper() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

describe("isTransientRpcError", () => {
  it.each([429, 500, 502, 503, 504, 599])("retries HTTP %i", (status) => {
    expect(isTransientRpcError(httpError(status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 413, 600])("does not retry HTTP %i", (status) => {
    expect(isTransientRpcError(httpError(status))).toBe(false);
  });

  it.each(["Failed to fetch", "fetch failed", "Load failed", "NetworkError when attempting to fetch resource.", "Network request failed"])(
    "retries a request that got no response (TypeError: %s)",
    (message) => {
      expect(isTransientRpcError(new TypeError(message))).toBe(true);
    },
  );

  it("does not retry a decode, account or JSON-RPC parameter error, a plain TypeError, or an abort", () => {
    expect(isTransientRpcError(new SolanaError(SOLANA_ERROR__ACCOUNTS__ACCOUNT_NOT_FOUND, { address: address("11111111111111111111111111111111") }))).toBe(false);
    expect(isTransientRpcError(new SolanaError(SOLANA_ERROR__JSON_RPC__INVALID_PARAMS, { __serverMessage: "bad" }))).toBe(false);
    expect(isTransientRpcError(new TypeError("Cannot read properties of undefined (reading 'data')"))).toBe(false);
    expect(isTransientRpcError(new DOMException("The operation was aborted.", "AbortError"))).toBe(false);
    expect(isTransientRpcError(new Error("429"))).toBe(false); // read from the code, never the message
    expect(isTransientRpcError(null)).toBe(false);
    expect(isTransientRpcError(undefined)).toBe(false);
  });

  it("follows a short cause chain (a wrapper around the RPC's error)", () => {
    expect(isTransientRpcError(new Error("read failed", { cause: httpError(429) }))).toBe(true);
    expect(isTransientRpcError(new Error("read failed", { cause: new Error("again", { cause: new TypeError("fetch failed") }) }))).toBe(true);
    expect(isTransientRpcError(new Error("read failed", { cause: httpError(404) }))).toBe(false);
  });
});

describe("retryDelayMs", () => {
  it("is the base ±25 %, never negative", () => {
    expect(RPC_READ_RETRY_DELAYS_MS).toEqual([500, 1_000, 2_000]);
    expect(RPC_READ_RETRY_JITTER).toBe(0.25);
    expect(retryDelayMs(1_000, () => 0)).toBe(750);
    expect(retryDelayMs(1_000, () => 0.5)).toBe(1_000);
    expect(retryDelayMs(1_000, () => 0.999999)).toBe(1_250);
    expect(retryDelayMs(0, () => 0)).toBe(0);
    for (let i = 0; i < 200; i++) {
      const d = retryDelayMs(500);
      expect(d).toBeGreaterThanOrEqual(375);
      expect(d).toBeLessThanOrEqual(625);
    }
  });
});

describe("withRpcReadRetry", () => {
  it("answers at once when the first read succeeds (no wait)", async () => {
    const { waits, sleep } = sleeper();
    const read = flaky([], "state");
    await expect(withRpcReadRetry(read, { sleep })).resolves.toBe("state");
    expect(read).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("retries a 429 after a send and answers when the RPC lets it through", async () => {
    const { waits, sleep } = sleeper();
    const read = flaky([httpError(429), httpError(429)], "state");
    await expect(withRpcReadRetry(read, { sleep, random: () => 0.5 })).resolves.toBe("state");
    expect(read).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([500, 1_000]);
  });

  it("backs off ~0.5, 1, 2 s with jitter, then throws the last transient error unchanged (4 reads at most)", async () => {
    const { waits, sleep } = sleeper();
    const last = httpError(503);
    const read = flaky([httpError(429), new TypeError("Failed to fetch"), httpError(502), last], "never");
    const randoms = [0, 0.999999, 0.5];
    await expect(withRpcReadRetry(read, { sleep, random: () => randoms.shift()! })).rejects.toBe(last);
    expect(read).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([375, 1_250, 2_000]);
  });

  it("throws a non-transient error at once, without retrying", async () => {
    const { waits, sleep } = sleeper();
    const decode = new Error("Failed to decode account data");
    const read = flaky([decode], "never");
    await expect(withRpcReadRetry(read, { sleep })).rejects.toBe(decode);
    expect(read).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it("stops retrying as soon as the failure is not transient any more", async () => {
    const { waits, sleep } = sleeper();
    const notFound = httpError(404);
    const read = flaky([httpError(429), notFound], "never");
    await expect(withRpcReadRetry(read, { sleep, random: () => 0.5 })).rejects.toBe(notFound);
    expect(read).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([500]);
  });

  it("is bounded by the delays it is given (none: one read)", async () => {
    const { sleep } = sleeper();
    const read = flaky([httpError(429)], "never");
    await expect(withRpcReadRetry(read, { sleep, delaysMs: [] })).rejects.toMatchObject({ context: { statusCode: 429 } });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("waits with real timers by default", async () => {
    vi.useFakeTimers();
    try {
      const read = flaky([httpError(429)], "state");
      const result = withRpcReadRetry(read, { random: () => 0.5 });
      await vi.advanceTimersByTimeAsync(499);
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe("state");
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the tokenize checklist reads through it", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "components/tokenize-checklist.tsx"), "utf8");

  it("retries the token's state, the extras and the permission; the notice stays for the last failure", () => {
    expect(src).toContain("withRpcReadRetry(() => readTokenizeState(rpc, assetPda))");
    expect(src).toContain("withRpcReadRetry(() => issuerKybVerified(rpc, issuer))");
    expect(src).toContain("withRpcReadRetry(() => listOpenSales(");
    expect(src).toContain("withRpcReadRetry(() => listShareClassSaleApprovals(");
    expect(src).toContain("withRpcReadRetry(() => loadIssuerPermission(");
    expect(src).toContain("Could not read the token&apos;s state from the chain.");
    expect(src).toMatch(/catch \{[^}]*if \(current\(\)\) setFailed\(true\);/);
  });

  it("commits only the latest load (a retrying older load never overwrites a newer one)", () => {
    expect(src).toContain("const [latest] = useState(createLatestGate);");
    expect(src).toContain("const current = latest.begin();");
    expect(src).toMatch(/if \(!current\(\)\) return;\s*setState\(next\);/);
  });
});
