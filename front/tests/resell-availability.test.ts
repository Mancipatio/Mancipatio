import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletSession } from "@solana/client";
const mocks = vi.hoisted(() => ({ configured: true, result: vi.fn(), filters: [] as unknown[][], signedFetch: vi.fn() }));
vi.mock("@/lib/network", () => ({ detectNetwork: () => "devnet" }));
vi.mock("@/lib/siws-client", () => ({ signedFetch: mocks.signedFetch }));
vi.mock("@/lib/supabase", () => ({ getSupabase: () => !mocks.configured ? null : { from: () => {
  let from = 0; const q = { select: () => q, order: () => q,
    eq: (...args: unknown[]) => { mocks.filters.push(args); return q; }, range: (offset: number) => { from = offset; return q; },
    abortSignal: (signal: AbortSignal) => mocks.result(from, signal) }; return q;
} } }));
import { listAllResellListings, listMyResellListings, listResellListings } from "@/lib/resell";
const SESSION = { account: { address: "wallet" } } as unknown as WalletSession;
const LIST = "/api/resell/list";
beforeEach(() => { mocks.configured = true; mocks.filters.length = 0; vi.clearAllMocks(); mocks.result.mockResolvedValue({ data: [], error: null }); mocks.signedFetch.mockResolvedValue([]); });

describe("public board: the anon client, active listings of the network only (0082)", () => {
  it("distinguishes an empty market from an unavailable or unconfigured database", async () => {
    await expect(listResellListings()).resolves.toEqual([]);
    mocks.result.mockResolvedValue({ data: null, error: { message: "paused" } }); await expect(listResellListings()).rejects.toThrow(/unavailable/);
    mocks.configured = false; await expect(listResellListings()).rejects.toThrow(/configured/);
  });
  it("always asks for active listings, whether or not the caller says so", async () => {
    await listResellListings();
    expect(mocks.filters).toEqual([["network", "devnet"], ["status", "active"]]);
    mocks.filters.length = 0;
    await listResellListings({ status: "active", mint: "mint" });
    expect(mocks.filters).toEqual([["network", "devnet"], ["status", "active"], ["mint", "mint"]]);
  });
  it("reads beyond the first 1000 rows and does not return a partial catalogue when a later page fails", async () => {
    mocks.result.mockImplementation(async (offset) => ({ data: offset === 0 ? Array.from({ length: 1000 }, (_, i) => ({ id: String(i) })) : [{ id: "1000" }], error: null }));
    expect(await listResellListings()).toHaveLength(1001);
    expect(mocks.result.mock.calls[1]).toEqual([1000, expect.any(AbortSignal)]);
    mocks.result.mockReset().mockResolvedValueOnce({ data: Array.from({ length: 1000 }, () => ({ id: "row" })), error: null }).mockResolvedValueOnce({ data: null, error: { message: "timeout" } });
    await expect(listResellListings({ mint: "mint" })).rejects.toThrow(/unavailable/);
  });
});

describe("own history and the admin board: signed reads on the service role", () => {
  it("reads the seller's own listings through /api/resell/list scope mine in pages of 100, never the anon client", async () => {
    mocks.signedFetch.mockImplementation(async (...args: unknown[]) => (args[3] as { offset: number }).offset === 0 ? Array.from({ length: 100 }, (_, i) => ({ id: String(i) })) : [{ id: "100" }]);
    expect(await listMyResellListings(SESSION)).toHaveLength(101);
    expect(mocks.signedFetch.mock.calls).toEqual([
      [SESSION, LIST, "resell.list", { scope: "mine", offset: 0 }],
      [SESSION, LIST, "resell.list", { scope: "mine", offset: 100 }],
    ]);
    expect(mocks.result).not.toHaveBeenCalled();
  });
  it("sends no wallet: the server binds scope mine to the verified signer", async () => {
    await listMyResellListings(SESSION, "withdrawn");
    expect(mocks.signedFetch).toHaveBeenCalledWith(SESSION, LIST, "resell.list", { scope: "mine", status: "withdrawn", offset: 0 });
    expect(Object.keys(mocks.signedFetch.mock.calls[0][3])).toEqual(["scope", "status", "offset"]);
  });
  it("the admin board reads every status through scope admin, with an optional status filter", async () => {
    await listAllResellListings(SESSION);
    expect(mocks.signedFetch).toHaveBeenCalledWith(SESSION, LIST, "resell.list", { scope: "admin", offset: 0 });
    await listAllResellListings(SESSION, "removed");
    expect(mocks.signedFetch).toHaveBeenLastCalledWith(SESSION, LIST, "resell.list", { scope: "admin", status: "removed", offset: 0 });
    expect(mocks.result).not.toHaveBeenCalled();
  });
  it("surfaces the server's refusal instead of an empty history", async () => {
    mocks.signedFetch.mockRejectedValue(new Error("Listings unavailable — try again"));
    await expect(listMyResellListings(SESSION)).rejects.toThrow(/unavailable/);
    await expect(listAllResellListings(SESSION)).rejects.toThrow(/unavailable/);
  });
});
