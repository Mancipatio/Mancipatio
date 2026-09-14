import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ configured: true, result: vi.fn(), filters: [] as unknown[][] }));
vi.mock("@/lib/network", () => ({ detectNetwork: () => "devnet" }));
vi.mock("@/lib/supabase", () => ({ getSupabase: () => !mocks.configured ? null : { from: () => {
  let from = 0; const q = { select: () => q, order: () => q,
    eq: (...args: unknown[]) => { mocks.filters.push(args); return q; }, range: (offset: number) => { from = offset; return q; },
    abortSignal: (signal: AbortSignal) => mocks.result(from, signal) }; return q;
} } }));
import { listResellListings, listMyResellListings } from "@/lib/resell";
beforeEach(() => { mocks.configured = true; mocks.filters.length = 0; vi.clearAllMocks(); mocks.result.mockResolvedValue({ data: [], error: null }); });
describe("resell availability and complete network-scoped reads", () => {
  it("distinguishes an empty market from an unavailable or unconfigured database", async () => {
    await expect(listResellListings()).resolves.toEqual([]);
    mocks.result.mockResolvedValue({ data: null, error: { message: "paused" } }); await expect(listResellListings()).rejects.toThrow(/unavailable/);
    mocks.configured = false; await expect(listMyResellListings("wallet")).rejects.toThrow(/configured/);
  });
  it("applies the network filter to seller history and reads beyond the first 1000 rows", async () => {
    mocks.result.mockImplementation(async (offset) => ({ data: offset === 0 ? Array.from({ length: 1000 }, (_, i) => ({ id: String(i) })) : [{ id: "1000" }], error: null }));
    expect(await listMyResellListings("wallet")).toHaveLength(1001);
    expect(mocks.filters).toContainEqual(["network", "devnet"]); expect(mocks.filters).toContainEqual(["seller_wallet", "wallet"]);
    expect(mocks.result.mock.calls[1]).toEqual([1000, expect.any(AbortSignal)]);
  });
  it("does not return a partial catalogue when a later page fails", async () => {
    mocks.result.mockResolvedValueOnce({ data: Array.from({ length: 1000 }, () => ({ id: "row" })), error: null }).mockResolvedValueOnce({ data: null, error: { message: "timeout" } });
    await expect(listResellListings({ status: "active", mint: "mint" })).rejects.toThrow(/unavailable/);
    expect(mocks.filters).toContainEqual(["status", "active"]); expect(mocks.filters).toContainEqual(["mint", "mint"]);
  });
});
