import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), indexer: vi.fn(), purchases: vi.fn(), abortSignals: [] as AbortSignal[] }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/server/indexer-sync", () => ({ reconcileIndexerJobs: mocks.indexer }));
vi.mock("@/lib/server/purchase-records", () => ({ reconcilePurchases: mocks.purchases }));
vi.mock("@/lib/network", () => ({ detectNetwork: () => "devnet" }));
import { POST, maxDuration } from "@/app/api/internal/retry/route";
import { runRetryWorker, retryWorkerLimit } from "@/lib/server/retry-worker";

const SECRET = "fixture-scheduler-secret-32-characters-only";
const COUNTS = { complete: 1, pending: 2, invalid: 0 };
function rpcResult(data: boolean | null = true, error: unknown = null) {
  return { abortSignal: (signal: AbortSignal) => { mocks.abortSignals.push(signal); return Promise.resolve({ data, error }); } };
}
const request = (authorization: string | null = `Bearer ${SECRET}`, query = "") => new Request(`http://localhost/api/internal/retry${query}`, {
  method: "POST", headers: authorization ? { authorization } : {}, body: JSON.stringify({ network: "mainnet", limit: 999 }),
});
beforeEach(() => {
  vi.clearAllMocks(); mocks.abortSignals.length = 0;
  vi.stubEnv("RETRY_WORKER_SECRET", SECRET);
  mocks.rpc.mockImplementation(() => rpcResult());
  mocks.indexer.mockResolvedValue(COUNTS); mocks.purchases.mockResolvedValue(COUNTS);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("scheduler authorization", () => {
  it.each([undefined, "", "too-short", "a sufficiently long secret with whitespace"])("fails closed without a usable configured secret (%s)", async (secret) => {
    vi.stubEnv("RETRY_WORKER_SECRET", secret);
    expect((await POST(request())).status).toBe(503);
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.indexer).not.toHaveBeenCalled(); expect(mocks.purchases).not.toHaveBeenCalled();
  });
  it.each([null, "", "Bearer incorrect", "Basic abc", `Bearer ${SECRET} extra`])("rejects unauthenticated requests before leasing or executing jobs (%s)", async (authorization) => {
    expect((await POST(request(authorization))).status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.indexer).not.toHaveBeenCalled(); expect(mocks.purchases).not.toHaveBeenCalled();
  });
  it("selects the deployment network, ignores body options, and uses bounded server defaults", async () => {
    const response = await POST(request()); const body = await response.json();
    expect(response.status).toBe(200); expect(body.data.network).toBe("devnet");
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, "acquire_retry_worker_lease", expect.objectContaining({ p_network: "devnet", p_ttl_seconds: 120 }));
    expect(mocks.indexer.mock.calls[0][0]).toBe(10); expect(mocks.purchases.mock.calls[0][0]).toBe(10);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store"); expect(maxDuration).toBe(60);
  });
  it.each(["0", "21", "1.5", "-1", "NaN", "01"])("rejects an invalid query limit %s without leasing", async (limit) => {
    expect((await POST(request(`Bearer ${SECRET}`, `?limit=${limit}`))).status).toBe(400); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("accepts the bounded limit and rejects invalid direct helper limits", async () => {
    expect(retryWorkerLimit("20")).toBe(20);
    expect((await POST(request(`Bearer ${SECRET}`, "?limit=3"))).status).toBe(200);
    expect(mocks.indexer.mock.calls[0][0]).toBe(3); expect(mocks.purchases.mock.calls[0][0]).toBe(3);
    await expect(runRetryWorker(21)).rejects.toMatchObject({ status: 400 });
  });
});

describe("persistent worker lease and deadlines", () => {
  it("skips overlapping runs without executing work or releasing the other owner's lease", async () => {
    mocks.rpc.mockImplementation(() => rpcResult(false));
    const response = await POST(request());
    expect(response.status).toBe(200); expect((await response.json()).data.status).toBe("busy");
    expect(mocks.rpc).toHaveBeenCalledTimes(1); expect(mocks.indexer).not.toHaveBeenCalled(); expect(mocks.purchases).not.toHaveBeenCalled();
  });
  it("fails closed on an unavailable or malformed lease response", async () => {
    mocks.rpc.mockImplementationOnce(() => rpcResult(null, { message: "database down" }));
    expect((await POST(request())).status).toBe(503);
    expect(mocks.indexer).not.toHaveBeenCalled(); expect(mocks.purchases).not.toHaveBeenCalled();
  });
  it("continues the independent queue and releases exactly its own lease after a job runner fails", async () => {
    mocks.indexer.mockRejectedValue(new Error("internal-only-detail"));
    const response = await POST(request()); const body = await response.json();
    expect(response.status).toBe(503); expect(body.data.indexer.status).toBe("failed");
    expect(mocks.purchases).toHaveBeenCalledOnce(); expect(JSON.stringify(body)).not.toContain("internal-only-detail");
    const owner = mocks.rpc.mock.calls[0][1].p_owner;
    expect(owner).toMatch(/^[a-f0-9-]{36}$/);
    expect(mocks.rpc).toHaveBeenLastCalledWith("release_retry_worker_lease", { p_network: "devnet", p_owner: owner });
    expect(mocks.abortSignals).toHaveLength(2); expect(mocks.abortSignals[1]).not.toBe(mocks.abortSignals[0]);
  });
  it("bounds each queue deadline to twenty seconds within the total work budget", async () => {
    let now = 100_000; vi.spyOn(Date, "now").mockImplementation(() => now);
    mocks.indexer.mockImplementation(async (_limit, deadline, signal) => {
      expect(deadline).toBe(120_000); expect(signal).toBeInstanceOf(AbortSignal);
      now = 120_000; return COUNTS;
    });
    mocks.purchases.mockImplementation(async (_limit, deadline, signal) => {
      expect(deadline).toBe(140_000); expect(signal).toBeInstanceOf(AbortSignal);
      now = 140_000; return COUNTS;
    });
    expect((await runRetryWorker()).status).toBe("processed");
    expect(now - 100_000).toBeLessThan(50_000);
  });
  it("leaves later jobs deferred when the total budget is exhausted, then releases with a fresh signal", async () => {
    let now = 100_000; vi.spyOn(Date, "now").mockImplementation(() => now);
    mocks.indexer.mockImplementation(async () => { now = 147_000; throw new Error("deadline"); });
    const result = await runRetryWorker();
    expect(result).toMatchObject({ status: "processed", indexer: { status: "deferred" }, purchases: { status: "deferred" } });
    expect(mocks.purchases).not.toHaveBeenCalled(); expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.abortSignals[1].aborted).toBe(false);
  });
  it("surfaces failed release instead of reporting a fully successful run", async () => {
    mocks.rpc.mockImplementationOnce(() => rpcResult()).mockImplementationOnce(() => rpcResult(false));
    expect((await POST(request())).status).toBe(503);
    expect(mocks.indexer).toHaveBeenCalledOnce(); expect(mocks.purchases).toHaveBeenCalledOnce();
  });
});
