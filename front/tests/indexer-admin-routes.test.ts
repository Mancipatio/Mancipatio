import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ verify: vi.fn(), admin: vi.fn(), retry: vi.fn(), all: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/siws", async (original) => ({ ...await original<typeof import("@/lib/server/siws")>(), verifySigned: mocks.verify }));
vi.mock("@/lib/server/admin-gate", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/server/indexer-sync", () => ({ reconcileIndexerJobs: mocks.retry, reconcileAllIndexerAccounts: mocks.all }));
import { POST as retry } from "@/app/api/admin/retry-indexer/route";
import { POST as all } from "@/app/api/admin/reconcile/route";
import { SiwsError } from "@/lib/server/siws";
const request = () => new Request("https://app.test/api/admin/reconcile", { method: "POST" });
beforeEach(() => { vi.resetAllMocks(); mocks.verify.mockResolvedValue({ wallet: "signer", params: { limit: 3 } }); mocks.admin.mockResolvedValue(undefined); mocks.retry.mockResolvedValue({ complete: 1, pending: 0, invalid: 0 }); mocks.all.mockResolvedValue({ network: "devnet", slot: 10, report: {} }); });
describe("signed administrator indexer operations", () => {
  it.each([[retry, "admin.retryIndexer"], [all, "admin.reconcile"]] as const)("requires matching signed action and administrator before working", async (route, action) => {
    const req = request(); const response = await route(req); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ ok: true, data: {} });
    expect(mocks.verify).toHaveBeenCalledWith(req, action); expect(mocks.admin).toHaveBeenCalledWith("signer");
  });
  it.each([401, 403])( "rejects unauthenticated/non-admin identities (%i)", async (status) => {
    if (status === 401) mocks.verify.mockRejectedValue(new SiwsError(401, "Signature required")); else mocks.admin.mockRejectedValue(new SiwsError(403, "Admin required"));
    expect((await retry(request())).status).toBe(status); expect((await all(request())).status).toBe(status);
    expect(mocks.retry).not.toHaveBeenCalled(); expect(mocks.all).not.toHaveBeenCalled();
  });
  it.each([0, 21, -1, 1.5, "3"])("rejects an unsafe signed retry limit %s", async (limit) => {
    mocks.verify.mockResolvedValue({ wallet: "signer", params: { limit } }); expect((await retry(request())).status).toBe(400); expect(mocks.retry).not.toHaveBeenCalled();
  });
  it("takes the limit from verified signed params and forwards cancellation", async () => {
    const req = request(); await retry(req);
    expect(mocks.retry).toHaveBeenCalledWith(3, expect.any(Number), req.signal);
  });
});
