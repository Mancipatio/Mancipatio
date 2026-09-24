// GET /api/priority-fee and lib/server/priority-fee (Talas 4.2 §2.3): the
// server asks its own RPC for getPriorityFeeEstimate and falls back to the
// floor for any RPC that does not support it. The RPC is a mocked fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ASSET_REGISTRY_PROGRAM_ADDRESS } from "@/lib/generated/asset_registry";
import { TRANSFER_HOOK_PROGRAM_ADDRESS } from "@/lib/generated/transfer_hook";

const SECRET_URL = "https://devnet.rpc-provider.example/?api-key=SECRET_KEY_123";
const MAINNET_URL = "https://mainnet.rpc-provider.example/?api-key=SECRET_KEY_456";
type Reply = Record<string, unknown> | Response | Error | "hang";
let reply: Reply;
const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
  if (reply === "hang") {
    return new Promise<Response>((_, reject) => {
      const fail = () => reject(new DOMException(`timed out ${SECRET_URL}`, "TimeoutError"));
      if (init?.signal?.aborted) fail();
      else init?.signal?.addEventListener("abort", fail);
    });
  }
  if (reply instanceof Error) throw reply;
  if (reply instanceof Response) return reply;
  return Response.json(reply);
});
const estimate = (priorityFeeEstimate: unknown) => ({ jsonrpc: "2.0", id: "manci-priority-fee", result: { priorityFeeEstimate } });

type Route = typeof import("@/app/api/priority-fee/route");
let route: Route;
let logs: string[];

beforeEach(async () => {
  vi.resetModules();
  route = await import("@/app/api/priority-fee/route");
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  vi.stubEnv("HELIUS_DEVNET_RPC", SECRET_URL);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  reply = estimate(4_321.2);
  logs = [];
  for (const level of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function get() {
  const response = await route.GET();
  return { status: response.status, headers: response.headers, body: await response.json() };
}

describe("GET /api/priority-fee", () => {
  it("asks the server RPC for getPriorityFeeEstimate over our two programs and rounds up", async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, network: "devnet", microLamports: "4322", source: "helius", level: "High" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(SECRET_URL);
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toEqual({
      jsonrpc: "2.0",
      id: "manci-priority-fee",
      method: "getPriorityFeeEstimate",
      params: [{ accountKeys: [ASSET_REGISTRY_PROGRAM_ADDRESS, TRANSFER_HOOK_PROGRAM_ADDRESS], options: { priorityLevel: "High" } }],
    });
  });

  it("is shareable by the CDN for a few seconds only", async () => {
    const { headers } = await get();
    expect(headers.get("cache-control")).toBe("public, max-age=0, s-maxage=5, stale-while-revalidate=10");
  });

  it("clamps an estimate to the network's cap and floor", async () => {
    reply = estimate(9e15);
    expect((await get()).body).toMatchObject({ microLamports: "100000", source: "helius" });
    vi.resetModules();
    route = await import("@/app/api/priority-fee/route");
    reply = estimate(0);
    expect((await get()).body).toMatchObject({ microLamports: "1000", source: "helius" });
  });

  it.each<[string, Reply]>([
    ["an RPC without the method (JSON-RPC error)", { jsonrpc: "2.0", id: 1, error: { code: -32601, message: `Method not found at ${SECRET_URL}` } }],
    ["a non-Helius result shape", { jsonrpc: "2.0", id: 1, result: { fee: 5 } }],
    ["a string estimate", estimate("5000")],
    ["a negative estimate", estimate(-1)],
    ["an infinite estimate", { jsonrpc: "2.0", id: 1, result: { priorityFeeEstimate: "Infinity" } }],
    ["an HTTP error", new Response("upstream", { status: 502 })],
    ["invalid JSON", new Response("<html>", { status: 200 })],
    ["a transport error carrying the URL", new TypeError(`fetch failed ${SECRET_URL}`)],
    ["a timeout", "hang"],
  ])("answers the floor with source \"floor\" for %s, never logging the URL", async (_label, value) => {
    reply = value;
    if (value === "hang") {
      vi.spyOn(AbortSignal, "timeout").mockImplementation(() => AbortSignal.abort(new DOMException("t", "TimeoutError")));
    }
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, network: "devnet", microLamports: "1000", source: "floor", level: "High" });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toMatch(/SECRET_KEY|rpc-provider|api-key/);
  });

  it("uses a 1.2 s RPC deadline", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await get();
    expect(timeout).toHaveBeenCalledWith(1_200);
  });

  it("fixed networks answer 0 without asking the RPC", async () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "localnet");
    expect((await get()).body).toEqual({ ok: true, network: "localnet", microLamports: "0", source: "floor", level: "High" });
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "testnet");
    expect((await get()).body).toMatchObject({ network: "testnet", microLamports: "0" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it("mainnet without a server RPC answers the mainnet floor; with one, it is clamped to 2,000,000", async () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    vi.stubEnv("HELIUS_MAINNET_RPC", "");
    vi.stubEnv("SOLANA_MAINNET_RPC", "");
    expect((await get()).body).toEqual({ ok: true, network: "mainnet", microLamports: "100000", source: "floor", level: "High" });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.resetModules();
    route = await import("@/app/api/priority-fee/route");
    vi.stubEnv("SOLANA_MAINNET_RPC", MAINNET_URL);
    reply = estimate(50_000_000);
    expect((await get()).body).toMatchObject({ network: "mainnet", microLamports: "2000000", source: "helius" });
    expect(fetchMock.mock.calls[0][0]).toBe(MAINNET_URL);
  });

  it("shares one RPC request per few seconds between concurrent and repeated callers", async () => {
    const [a, b] = await Promise.all([get(), get()]);
    expect(a.body).toEqual(b.body);
    await get();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("answers 503 uncached only for an invalid network setting", async () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "moonnet");
    const { status, headers, body } = await get();
    expect(status).toBe(503);
    expect(headers.get("cache-control")).toBe("no-store");
    expect(body.ok).toBe(false);
  });
});
