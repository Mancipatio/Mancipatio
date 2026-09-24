// lib/priority-fee (Talas 4.2 §2.2): the browser side of the one fee point.
// The oracle (GET /api/priority-fee) is a mocked fetch; no network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { address, type Address, type Instruction } from "@solana/kit";
import {
  MAX_COMPUTE_UNIT_PRICE,
  SEND_OVERHEAD_INSTRUCTIONS,
  TRANSACTION_SIZE_LIMIT,
  setComputeUnitLimitInstruction,
  setComputeUnitPriceInstruction,
  transactionSize,
} from "@/lib/compute-budget";
import {
  ORACLE_TIMEOUT_MS,
  PRICE_CACHE_MS,
  PRIORITY_FEE_POLICY,
  assertFeePolicies,
  clampComputeUnitPrice,
  priceForRequest,
  resetPriorityFeeCache,
  resolveComputeUnitPrice,
  type FeePolicy,
} from "@/lib/priority-fee";

const PAYER = address("7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2");
const PROGRAM = address("FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS");
const NOW = new Date("2026-09-24T10:00:00Z").getTime();

type Reply = Record<string, unknown> | Response | Error | "hang";
let reply: Reply;
const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
  if (reply === "hang") {
    return new Promise<Response>((_, reject) => {
      const fail = () => reject(new DOMException("The operation timed out.", "TimeoutError"));
      if (init?.signal?.aborted) fail();
      else init?.signal?.addEventListener("abort", fail);
    });
  }
  if (reply instanceof Error) throw reply;
  if (reply instanceof Response) return reply;
  return Response.json(reply);
});
let warn: ReturnType<typeof vi.spyOn>;

const good = (microLamports: string, network = "devnet") => ({ ok: true, network, microLamports, source: "helius", level: "High" });
const ix = (bytes: number): Instruction => ({ programAddress: PROGRAM, data: new Uint8Array(bytes) });

beforeEach(() => {
  resetPriorityFeeCache();
  reply = good("5000");
  fetchMock.mockClear();
  vi.stubGlobal("window", {});
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  warn.mockRestore();
});

describe("clampComputeUnitPrice and the policies", () => {
  const policy: FeePolicy = { mode: "oracle", floor: BigInt(1_000), cap: BigInt(100_000), level: "High" };

  it("null is the floor; values are bounded to [floor, cap]", () => {
    expect(clampComputeUnitPrice(null, policy)).toBe(BigInt(1_000));
    expect(clampComputeUnitPrice(BigInt(0), policy)).toBe(BigInt(1_000));
    expect(clampComputeUnitPrice(BigInt(5_000), policy)).toBe(BigInt(5_000));
    expect(clampComputeUnitPrice(BigInt(100_001), policy)).toBe(BigInt(100_000));
  });

  it("never exceeds the hard cap, even for a policy that would", () => {
    const loose: FeePolicy = { ...policy, cap: BigInt(10_000_000) };
    expect(clampComputeUnitPrice(BigInt(9_000_000), loose)).toBe(MAX_COMPUTE_UNIT_PRICE);
  });

  it("every configured policy is inside 0 <= floor <= cap <= MAX_COMPUTE_UNIT_PRICE (checked at load)", () => {
    for (const p of Object.values(PRIORITY_FEE_POLICY)) {
      expect(p.floor >= BigInt(0) && p.floor <= p.cap && p.cap <= MAX_COMPUTE_UNIT_PRICE).toBe(true);
    }
    expect(() => assertFeePolicies(PRIORITY_FEE_POLICY)).not.toThrow();
    expect(() => assertFeePolicies({ x: { ...policy, cap: MAX_COMPUTE_UNIT_PRICE + BigInt(1) } })).toThrow(/outside/);
    expect(() => assertFeePolicies({ x: { ...policy, floor: BigInt(200_000) } })).toThrow(/outside/);
  });

  it("D1: mainnet floor 100k / cap 2M, devnet 1k / 100k, testnet and localnet a fixed 0", () => {
    expect(PRIORITY_FEE_POLICY.mainnet).toEqual({ mode: "oracle", floor: BigInt(100_000), cap: BigInt(2_000_000), level: "High" });
    expect(PRIORITY_FEE_POLICY.devnet).toEqual({ mode: "oracle", floor: BigInt(1_000), cap: BigInt(100_000), level: "High" });
    expect(PRIORITY_FEE_POLICY.testnet).toMatchObject({ mode: "fixed", floor: BigInt(0), cap: BigInt(0) });
    expect(PRIORITY_FEE_POLICY.localnet).toMatchObject({ mode: "fixed", floor: BigInt(0), cap: BigInt(0) });
  });
});

describe("resolveComputeUnitPrice", () => {
  it("reads GET /api/priority-fee without the browser cache and with a timeout", async () => {
    await expect(resolveComputeUnitPrice("devnet")).resolves.toBe(BigInt(5_000));
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/priority-fee");
    expect(init?.cache).toBe("no-store");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(ORACLE_TIMEOUT_MS).toBe(2_000);
  });

  it("clamps whatever the server answered to the network's cap and floor", async () => {
    reply = good("99999999999");
    await expect(resolveComputeUnitPrice("devnet")).resolves.toBe(BigInt(100_000));
    resetPriorityFeeCache();
    reply = good("5");
    await expect(resolveComputeUnitPrice("devnet")).resolves.toBe(BigInt(1_000));
    resetPriorityFeeCache();
    reply = good("99999999999", "mainnet");
    await expect(resolveComputeUnitPrice("mainnet")).resolves.toBe(BigInt(2_000_000));
  });

  it.each<[string, Reply]>([
    ["another network", good("5000", "mainnet")],
    ["ok false", { ok: false, network: "devnet", microLamports: "5000" }],
    ["a number instead of a string", { ok: true, network: "devnet", microLamports: 5000 }],
    ["a negative value", good("-5")],
    ["a decimal", good("5.5")],
    ["21 digits", good("1".repeat(21))],
    ["an HTTP error", new Response("{}", { status: 503 })],
    ["invalid JSON", new Response("nope", { status: 200 })],
    ["a transport error", new TypeError("Failed to fetch")],
  ])("uses the floor for %s, with a detail-free warning", async (_label, value) => {
    reply = value;
    await expect(resolveComputeUnitPrice("devnet")).resolves.toBe(BigInt(1_000));
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0].join(" ")).not.toMatch(/5000|nope|Failed|503/);
  });

  it("uses the floor when the oracle times out, and aborts the request", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    reply = "hang";
    const price = resolveComputeUnitPrice("devnet");
    await vi.advanceTimersByTimeAsync(ORACLE_TIMEOUT_MS);
    await expect(price).resolves.toBe(BigInt(1_000));
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
  });

  it.each([
    ["a response that ignores the abort signal", () => new Promise<Response>(() => {})],
    ["a body that never finishes", async () => ({ ok: true, json: () => new Promise(() => {}) }) as unknown as Response],
  ])("the 2 s deadline holds for %s (own timer, even without AbortSignal.timeout)", async (_label, stalled) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.stubGlobal("AbortSignal", Object.assign(function AbortSignalStub() {}, { timeout: undefined }));
    fetchMock.mockImplementationOnce(stalled);
    const price = resolveComputeUnitPrice("devnet");
    let settled = false;
    void price.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(ORACLE_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(price).resolves.toBe(BigInt(1_000));
    expect(warn).toHaveBeenCalledOnce();
  });

  it("shares one request between concurrent callers and reuses the price for 10 s", async () => {
    const [a, b] = await Promise.all([resolveComputeUnitPrice("devnet"), resolveComputeUnitPrice("devnet")]);
    expect([a, b]).toEqual([BigInt(5_000), BigInt(5_000)]);
    expect(fetchMock).toHaveBeenCalledOnce();
    reply = good("7000");
    vi.setSystemTime(NOW + PRICE_CACHE_MS - 1);
    await expect(resolveComputeUnitPrice("devnet")).resolves.toBe(BigInt(5_000));
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.setSystemTime(NOW + PRICE_CACHE_MS + 1);
    await expect(resolveComputeUnitPrice("devnet")).resolves.toBe(BigInt(7_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fixed networks answer their floor (0) without a request", async () => {
    await expect(resolveComputeUnitPrice("testnet")).resolves.toBe(BigInt(0));
    await expect(resolveComputeUnitPrice("localnet")).resolves.toBe(BigInt(0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("outside a browser it answers the floor without a request", async () => {
    vi.stubGlobal("window", undefined);
    await expect(resolveComputeUnitPrice("mainnet")).resolves.toBe(BigInt(100_000));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects only when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(resolveComputeUnitPrice("devnet", controller.signal)).rejects.toThrow("stop");
  });
});

describe("priceForRequest", () => {
  it("answers the resolved price for a request that fits", async () => {
    await expect(priceForRequest("devnet", PAYER, { instructions: [ix(100)] })).resolves.toBe(BigInt(5_000));
  });

  it("leaves the price out when SetComputeUnitPrice would push the transaction over 1232 B", async () => {
    // Fits without the 9-byte price instruction, not with it (measured with both placeholders).
    let size = 1_000;
    while (transactionSize(PAYER, [...SEND_OVERHEAD_INSTRUCTIONS, ix(size + 1)]) <= TRANSACTION_SIZE_LIMIT) size++;
    const fits = [ix(size)];
    const tooBig = [ix(size + 1)];
    expect(transactionSize(PAYER, [setComputeUnitLimitInstruction(0), ...tooBig])).toBeLessThanOrEqual(TRANSACTION_SIZE_LIMIT);
    await expect(priceForRequest("devnet", PAYER, { instructions: tooBig })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(priceForRequest("devnet", PAYER, { instructions: fits })).resolves.toBe(BigInt(5_000));
    fetchMock.mockClear();
    await expect(priceForRequest("devnet", PAYER, { instructions: [ix(1_300)] })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a caller-set price or a SetComputeUnitPrice instruction", async () => {
    await expect(priceForRequest("devnet", PAYER, { instructions: [ix(1)], computeUnitPrice: BigInt(0) })).rejects.toThrow(
      /set by the app/,
    );
    await expect(
      priceForRequest("devnet", PAYER, { instructions: [setComputeUnitPriceInstruction(BigInt(1)), ix(1)] }),
    ).rejects.toThrow(/SetComputeUnitPrice/);
    // A limit instruction is fine.
    await expect(
      priceForRequest("devnet", PAYER, { instructions: [setComputeUnitLimitInstruction(10_000), ix(1)] }),
    ).resolves.toBe(BigInt(5_000));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fixed networks get an explicit 0 (deterministic sizes)", async () => {
    await expect(priceForRequest("localnet", PAYER as Address, { instructions: [ix(1)] })).resolves.toBe(BigInt(0));
  });
});
