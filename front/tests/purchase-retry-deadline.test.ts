import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
type DbResult = { data: unknown; error: null | { code?: string; message: string } };
const mocks = vi.hoisted(() => ({
  proof: vi.fn(), from: vi.fn(), calls: [] as Array<[string, ...unknown[]]>,
  responses: [] as Array<DbResult | (() => DbResult)>, signals: [] as AbortSignal[],
}));
vi.mock("@/lib/server/chain-evidence", () => ({ requirePurchaseEvidence: mocks.proof }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({ from: mocks.from }) }));
vi.mock("@/lib/network", () => ({ detectNetwork: () => "devnet" }));
import { processPurchaseJob, reconcilePurchases } from "@/lib/server/purchase-records";
import { SiwsError } from "@/lib/server/siws";
const JOB = { id: "job-1", network: "devnet", buyer: "buyer", sale_pubkey: "sale", signature: "signature", requested_instruction: -1, attempts: 0 };
const PROOF = { amount: 10, paymentMint: "usdc", decimals: 6, amountAtomic: "10000000", units: "1", instructionIndex: 0, slot: 100 };
const result = (data: unknown = null, error: DbResult["error"] = null): DbResult => ({ data, error });
beforeEach(() => {
  vi.clearAllMocks(); mocks.calls.length = 0; mocks.responses.length = 0; mocks.signals.length = 0;
  mocks.proof.mockResolvedValue(PROOF);
  mocks.from.mockImplementation((table: string) => {
    mocks.calls.push(["from", table]);
    const query = Object.fromEntries(["select", "eq", "neq", "lte", "order", "limit", "insert", "update", "single", "maybeSingle"].map((method) => [method, (...args: unknown[]) => { mocks.calls.push([method, ...args]); return query; }])) as Record<string, unknown>;
    query.abortSignal = (signal: AbortSignal) => { mocks.signals.push(signal); return query; };
    query.then = (resolve: (value: DbResult) => unknown) => {
      const next = mocks.responses.shift() ?? result();
      return Promise.resolve(typeof next === "function" ? next() : next).then(resolve);
    };
    return query;
  });
});
afterEach(() => vi.restoreAllMocks());

describe("cooperative purchase retry deadlines", () => {
  it("does not query or consume jobs after an expired deadline or already-aborted run", async () => {
    expect(await reconcilePurchases(10, Date.now() - 1)).toEqual({ complete: 0, pending: 0, invalid: 0 });
    expect(await reconcilePurchases(10, Date.now() + 1000, AbortSignal.abort())).toEqual({ complete: 0, pending: 0, invalid: 0 });
    expect(mocks.from).not.toHaveBeenCalled(); expect(mocks.proof).not.toHaveBeenCalled();
  });
  it.each([0, 21, -1, 1.5, NaN])("rejects an unsafe retry batch limit %s", async (limit) => {
    await expect(reconcilePurchases(limit)).rejects.toMatchObject({ status: 400 }); expect(mocks.from).not.toHaveBeenCalled();
  });
  it("bounds the query to the active network, due pending rows and the supplied batch size", async () => {
    mocks.responses.push(result([]));
    expect(await reconcilePurchases(3)).toEqual({ complete: 0, pending: 0, invalid: 0 });
    expect(mocks.calls).toContainEqual(["eq", "network", "devnet"]);
    expect(mocks.calls).toContainEqual(["eq", "status", "pending"]);
    expect(mocks.calls).toContainEqual(["limit", 3]); expect(mocks.signals[0]).toBeInstanceOf(AbortSignal);
  });
  it("leaves a job pending and performs no status writes when verification is aborted", async () => {
    const controller = new AbortController();
    mocks.proof.mockImplementation(async () => { controller.abort(); throw new SiwsError(503, "deadline"); });
    expect(await processPurchaseJob(JOB, controller.signal)).toMatchObject({ status: "pending", jobId: JOB.id });
    expect(mocks.proof).toHaveBeenCalledWith(JOB.signature, JOB.sale_pubkey, JOB.buyer, undefined, controller.signal);
    expect(mocks.calls).toEqual([]);
  });
  it("does not persist evidence after the budget expires between proof and insert", async () => {
    const controller = new AbortController();
    mocks.proof.mockImplementation(async () => { controller.abort(); return PROOF; });
    expect(await processPurchaseJob(JOB, controller.signal)).toMatchObject({ status: "pending" });
    expect(mocks.calls).toEqual([]);
  });
  it("keeps an uncertain insert queued and does not acknowledge it after cancellation", async () => {
    const controller = new AbortController();
    mocks.responses.push(() => { controller.abort(); return result(null, { message: "aborted response" }); });
    expect(await processPurchaseJob(JOB, controller.signal)).toMatchObject({ status: "pending" });
    expect(mocks.calls.some(([method]) => method === "update")).toBe(false);
    expect(mocks.signals).toHaveLength(1); expect(mocks.signals[0].aborted).toBe(true);
  });
  it("stops after the current job when the shared deadline expires, leaving later rows untouched", async () => {
    let now = 100_000; vi.spyOn(Date, "now").mockImplementation(() => now);
    mocks.responses.push(result([JOB, { ...JOB, id: "job-2" }]), result({ id: "commitment-1" }), result());
    mocks.proof.mockImplementation(async () => { now = 106_000; return PROOF; });
    expect(await reconcilePurchases(10, 105_000)).toEqual({ complete: 0, pending: 1, invalid: 0 });
    expect(mocks.proof).toHaveBeenCalledOnce(); expect(mocks.signals).toHaveLength(1);
    expect(mocks.calls).not.toContainEqual(["eq", "id", "job-2"]);
  });
  it("keeps jobs pending if their invalid/retry acknowledgment cannot be persisted", async () => {
    mocks.proof.mockRejectedValue(new SiwsError(400, "Evidence mismatch"));
    mocks.responses.push(result(null, { message: "temporary database outage" }));
    expect(await processPurchaseJob(JOB)).toMatchObject({ status: "pending" });
  });
  it("retains the existing unique-evidence reconciliation path with bounded duplicate reads", async () => {
    mocks.responses.push(result(null, { code: "23505", message: "duplicate" }), result({ id: "existing", sale_pubkey: JOB.sale_pubkey, investor_wallet: JOB.buyer }), result());
    expect(await processPurchaseJob(JOB)).toMatchObject({ status: "complete", id: "existing" });
    expect(mocks.calls).toContainEqual(["eq", "evidence_verified", true]); expect(mocks.signals).toHaveLength(3);
  });
});
