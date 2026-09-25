import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(), indexer: vi.fn(), purchases: vi.fn(), ledger: vi.fn(), capacity: vi.fn(), heartbeat: vi.fn(),
  abortSignals: [] as AbortSignal[],
}));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/server/indexer-sync", () => ({ reconcileIndexerJobs: mocks.indexer }));
// The freshness heartbeat (0075) has its own suite (indexer-heartbeat.test.ts).
vi.mock("@/lib/server/indexer-heartbeat", () => ({ runIndexerHeartbeat: mocks.heartbeat }));
vi.mock("@/lib/server/purchase-records", () => ({ reconcilePurchases: mocks.purchases }));
vi.mock("@/lib/server/spv-issuance-jobs", () => ({ reconcileLedger: mocks.ledger }));
vi.mock("@/lib/server/sale-capacity", () => ({ reconcileSaleCapacity: mocks.capacity }));
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
const rpcNames = () => mocks.rpc.mock.calls.map((c) => c[0]);
beforeEach(() => {
  vi.clearAllMocks(); mocks.abortSignals.length = 0;
  vi.stubEnv("RETRY_WORKER_SECRET", SECRET);
  mocks.rpc.mockImplementation(() => rpcResult());
  for (const m of [mocks.indexer, mocks.purchases, mocks.ledger, mocks.capacity]) m.mockResolvedValue(COUNTS);
  mocks.heartbeat.mockResolvedValue({ status: "would_bump" });
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
    for (const m of [mocks.indexer, mocks.purchases, mocks.ledger, mocks.capacity]) expect(m.mock.calls[0][0]).toBe(10);
    expect(body.data.capacity).toEqual({ status: "processed", counts: COUNTS });
    expect(body.data.ledger).toEqual({ status: "processed", counts: COUNTS });
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
  it("runs indexer, purchases, the ledger, then the raise-cap backstop; a failure is partial", async () => {
    mocks.capacity.mockRejectedValue(new Error("ledger-internal-detail"));
    const response = await POST(request()); const body = await response.json();
    expect(response.status).toBe(503); expect(body.data.capacity.status).toBe("failed");
    expect(body.data.indexer.status).toBe("processed"); expect(body.data.purchases.status).toBe("processed");
    expect(body.data.ledger.status).toBe("processed");
    expect(JSON.stringify(body)).not.toContain("ledger-internal-detail");
    const order = [mocks.indexer, mocks.purchases, mocks.ledger, mocks.capacity].map((m) => m.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
  it("records its heartbeat (partial after a failure) before releasing the lease", async () => {
    mocks.ledger.mockRejectedValue(new Error("x"));
    await POST(request());
    expect(rpcNames()).toEqual(["acquire_retry_worker_lease", "record_worker_heartbeat", "release_retry_worker_lease"]);
    expect(mocks.rpc.mock.calls[1][1]).toMatchObject({ p_network: "devnet", p_worker: "retry", p_status: "partial", p_gap_scan: false });
    mocks.rpc.mockClear(); mocks.ledger.mockResolvedValue(COUNTS);
    await POST(request());
    expect(mocks.rpc.mock.calls[1][1]).toMatchObject({ p_status: "processed" });
  });
  it("a heartbeat failure never fails the run", async () => {
    mocks.rpc.mockImplementation((name: string) => (name === "record_worker_heartbeat" ? rpcResult(null, { message: "down" }) : rpcResult()));
    expect((await POST(request())).status).toBe(200);
  });
  it("answers 503 'Deployment network mismatch' when the lease's network assertion refuses", async () => {
    mocks.rpc.mockImplementationOnce(() => rpcResult(null, { code: "P0001", message: "DEPLOYMENT_NETWORK_MISMATCH database=mainnet deployment=devnet" }));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "Deployment network mismatch" });
    expect(mocks.indexer).not.toHaveBeenCalled();
  });
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
    expect(mocks.abortSignals).toHaveLength(3); expect(mocks.abortSignals[2]).not.toBe(mocks.abortSignals[0]);
  });
  it("gives each stage its budget (15/10/10 s) and the backstop what is left of the 47 s", async () => {
    let now = 100_000; vi.spyOn(Date, "now").mockImplementation(() => now);
    mocks.indexer.mockImplementation(async (_limit, deadline, signal) => {
      expect(deadline).toBe(115_000); expect(signal).toBeInstanceOf(AbortSignal);
      now = 115_000; return COUNTS;
    });
    mocks.purchases.mockImplementation(async (_limit, deadline) => { expect(deadline).toBe(125_000); now = 125_000; return COUNTS; });
    mocks.ledger.mockImplementation(async (_limit, deadline) => { expect(deadline).toBe(135_000); now = 135_000; return COUNTS; });
    mocks.capacity.mockImplementation(async (_limit, deadline, signal) => {
      expect(deadline).toBe(147_000); expect(signal).toBeInstanceOf(AbortSignal);
      now = 146_000; return COUNTS;
    });
    expect((await runRetryWorker()).status).toBe("processed");
    expect(mocks.capacity).toHaveBeenCalledOnce();
    expect(now - 100_000).toBeLessThan(50_000);
  });
  it("leaves later jobs deferred when the total budget is exhausted, then releases with a fresh signal", async () => {
    let now = 100_000; vi.spyOn(Date, "now").mockImplementation(() => now);
    mocks.indexer.mockImplementation(async () => { now = 147_000; throw new Error("deadline"); });
    const result = await runRetryWorker();
    expect(result).toMatchObject({
      status: "processed", indexer: { status: "deferred" }, purchases: { status: "deferred" },
      ledger: { status: "deferred" }, capacity: { status: "deferred" },
    });
    expect(mocks.purchases).not.toHaveBeenCalled(); expect(mocks.capacity).not.toHaveBeenCalled(); expect(mocks.rpc).toHaveBeenCalledTimes(3);
    expect(mocks.abortSignals[2].aborted).toBe(false);
  });
  it("runs the freshness heartbeat after the job loop, inside the indexer stage (same deadline and signal)", async () => {
    let now = 100_000; vi.spyOn(Date, "now").mockImplementation(() => now);
    let jobSignal: AbortSignal | undefined;
    mocks.indexer.mockImplementation(async (_limit, _deadline, signal) => { jobSignal = signal; now = 100_500; return COUNTS; });
    mocks.heartbeat.mockImplementation(async (deadline, signal) => {
      expect(deadline).toBe(115_000); expect(signal).toBe(jobSignal);
      now = 112_000; return { status: "bumped" };
    });
    mocks.purchases.mockImplementation(async (_limit, deadline) => { expect(deadline).toBe(122_000); return COUNTS; });
    const result = await runRetryWorker();
    expect(result).toMatchObject({ status: "processed", indexer: { status: "processed", counts: COUNTS }, freshness: { status: "bumped" } });
    expect(mocks.heartbeat.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.indexer.mock.invocationCallOrder[0]);
    expect(mocks.heartbeat.mock.invocationCallOrder[0]).toBeLessThan(mocks.purchases.mock.invocationCallOrder[0]);
  });
  it("a declined or throwing heartbeat never makes the run partial; freshness is its own field", async () => {
    mocks.heartbeat.mockResolvedValueOnce({ status: "declined", reason: "UNINDEXED_SIGNATURE", expired: false });
    let response = await POST(request()); let body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ status: "processed", indexer: { status: "processed" }, freshness: { status: "declined", reason: "UNINDEXED_SIGNATURE" } });
    mocks.heartbeat.mockRejectedValueOnce(new Error("https://rpc.invalid/?api-key=secret"));
    response = await POST(request()); body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ status: "processed", freshness: { status: "declined", reason: "INTERNAL_ERROR" } });
    expect(JSON.stringify(body)).not.toContain("api-key");
  });
  it("a failed job loop skips the heartbeat (freshness INDEXER_STAGE)", async () => {
    mocks.indexer.mockRejectedValue(new Error("queue down"));
    const result = await runRetryWorker();
    expect(result).toMatchObject({ status: "partial", indexer: { status: "failed" }, freshness: { status: "skipped", reason: "INDEXER_STAGE" } });
    expect(mocks.heartbeat).not.toHaveBeenCalled();
  });
  it("surfaces failed release instead of reporting a fully successful run", async () => {
    mocks.rpc.mockImplementation((name: string) => (name === "release_retry_worker_lease" ? rpcResult(false) : rpcResult()));
    expect((await POST(request())).status).toBe(503);
    expect(mocks.indexer).toHaveBeenCalledOnce(); expect(mocks.purchases).toHaveBeenCalledOnce();
  });
});
