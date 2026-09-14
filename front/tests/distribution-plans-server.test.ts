import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ read: vi.fn(), rpc: vi.fn(), query: vi.fn(), verify: vi.fn(), admin: vi.fn(), filters: [] as unknown[][] }));
vi.mock("@/lib/network", () => ({ detectNetwork: () => "devnet" }));
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => ({ getMultipleAccounts: (...args: unknown[]) => ({ send: (options: unknown) => mocks.read(...args, options) }) }) }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({
  rpc: (name: string, args: unknown) => ({ abortSignal: () => mocks.rpc(name, args) }),
  from: (table: string) => {
    const filters: unknown[][] = []; const result = () => Promise.resolve(mocks.query(table, filters));
    const q = { select: () => q, order: () => q, limit: () => q, abortSignal: () => q,
      eq: (...args: unknown[]) => { filters.push(["eq", ...args]); mocks.filters.push([table, ...args]); return q; },
      gt: (...args: unknown[]) => { filters.push(["gt", ...args]); return q; },
      contains: (...args: unknown[]) => { filters.push(["contains", ...args]); mocks.filters.push([table, ...args]); return q; },
      maybeSingle: result, then: (resolve: (value: unknown) => unknown) => result().then(resolve) };
    return q;
  },
}) }));
vi.mock("@/lib/server/admin-gate", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/server/siws", async (original) => ({ ...await original<typeof import("@/lib/server/siws")>(), verifySigned: mocks.verify }));
import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { ASSET_REGISTRY_PROGRAM_ADDRESS, findDistributionPda, getDistributionEncoder, getDistributionPlanEncoder, getDistributionBatchEncoder, DistributionStatus } from "@/lib/generated/asset_registry";
import { canonicalDistributionPlan, distributionPlanBytes } from "@/lib/distribution-plans";
import { prepareDistributionPlan, verifyDistributionPlanBinding, readDistributionPlan, readDistributionSelfProof } from "@/lib/server/distribution-plans";
import { SiwsError } from "@/lib/server/siws";
import { indexerFixtures } from "./helpers/indexer-fixtures";
import { POST as prepareRoute } from "@/app/api/distribution-plans/prepare/route";
import { POST as bindRoute } from "@/app/api/distribution-plans/bind/route";
import { POST as adminRead } from "@/app/api/distribution-plans/admin-read/route";
import { POST as selfProof } from "@/app/api/distribution-plans/proof/route";
const A = address("11111111111111111111111111111111");
const B = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ID = "10000000-0000-4000-8000-000000000001";
let plan: Awaited<ReturnType<typeof canonicalDistributionPlan>>;
const account = (data: Uint8Array, owner: string = ASSET_REGISTRY_PROGRAM_ADDRESS) => ({ owner, data: [Buffer.from(data).toString("base64"), "base64"] });
const shareClass = () => account(indexerFixtures().find((f) => f.table === "share_classes")!.bytes);
function mint() { const data = new Uint8Array(82); data[45] = 1; return account(data, B); }
function distribution(change = {}) { return account(new Uint8Array(getDistributionEncoder().encode({ admin: A, funder: A, shareClass: address(plan.share_class), mint: A, paymentMint: A, escrow: A, totalAmount: 100, snapshotSupply: 30, distributedAmount: 0, paidCount: 0, status: DistributionStatus.Distributing, distributionId: 7, version: 2, bump: 255, ...change }))); }
function committed(change = {}) { return account(new Uint8Array(getDistributionPlanEncoder().encode({ distribution: address(plan.distribution_pda), batchRoot: distributionPlanBytes(plan.root_hex), batchCount: plan.batch_count, version: 1, bump: 255, ...change }))); }
function receipt(change = {}) { return account(new Uint8Array(getDistributionBatchEncoder().encode({ distribution: address(plan.distribution_pda), batchId: 0, batchHash: distributionPlanBytes(plan.batches[0].leaf_hex), totalAmount: 100, paidCount: 2, version: 1, bump: 255, ...change }))); }
const stored = (status = "prepared") => ({ ...plan, batches: undefined, id: ID, status, network: "devnet", bound_slot: status === "bound" ? "123" : null });
const req = (body: unknown = {}) => new Request("https://app.test/api/distribution-plans", { method: "POST", body: JSON.stringify(body) });
function query(table: string, filters: unknown[][]) {
  return { data: table === "distribution_plan_metadata" ? stored() : filters.some((f) => f[0] === "contains") ? { batch_id: 0 } : plan.batches, error: null };
}
beforeEach(async () => {
  vi.clearAllMocks(); mocks.filters.length = 0;
  const sc = (await getProgramDerivedAddress({ programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS, seeds: [new TextEncoder().encode("share_class"), getAddressEncoder().encode(A), new Uint8Array([2])] }))[0];
  const entries = await Promise.all([A, B].map(async (wallet) => ({ token_owner: wallet, token_account: (await findAssociatedTokenPda({ owner: wallet, mint: A, tokenProgram: B }))[0], amount: wallet === A ? "40" : "60" })));
  plan = await canonicalDistributionPlan({ distribution_pda: (await findDistributionPda({ shareClass: sc, distributionId: BigInt(7) }))[0], distribution_id: "7", share_class: sc, payment_mint: A, payment_token_program: B, funder: A, total_amount: "100", snapshot_supply: "30" }, entries);
  mocks.verify.mockResolvedValue({ wallet: A, params: { ...plan, plan_id: ID } }); mocks.admin.mockResolvedValue(undefined);
  mocks.read.mockResolvedValue({ context: { slot: BigInt(123) }, value: [distribution(), committed(), shareClass(), mint()] });
  mocks.query.mockImplementation(query); mocks.rpc.mockResolvedValue({ data: ID, error: null });
});
describe("distribution plans bind original funding and private recipient evidence", () => {
  it("verifies finalized account owners, committed root/count and exact funding context", async () => {
    expect((await verifyDistributionPlanBinding(plan)).slot).toBe(123);
    expect(mocks.read.mock.calls[0][1]).toMatchObject({ commitment: "finalized" }); expect(mocks.read.mock.calls[0][2].abortSignal).toBeInstanceOf(AbortSignal);
  });
  it.each(["owner", "root", "count", "funder", "total", "version", "missing"])("rejects mismatched finalized %s without DB binding", async (field) => {
    const d = distribution({ ...(field === "funder" ? { funder: B } : {}), ...(field === "total" ? { totalAmount: 101 } : {}), ...(field === "version" ? { version: 1 } : {}) });
    const p = committed({ ...(field === "root" ? { batchRoot: new Uint8Array(32) } : {}), ...(field === "count" ? { batchCount: 2 } : {}) });
    if (field === "owner") p.owner = B;
    mocks.read.mockResolvedValue({ context: { slot: 123 }, value: [d, field === "missing" ? null : p, shareClass(), mint()] });
    await expect(verifyDistributionPlanBinding(plan)).rejects.toMatchObject({ status: 409 }); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("rejects incomplete or failed RPC responses", async () => {
    mocks.read.mockResolvedValue({ context: { slot: null }, value: [] }); await expect(verifyDistributionPlanBinding(plan)).rejects.toMatchObject({ status: 503 });
    mocks.read.mockRejectedValue(new Error("HTTP 429")); await expect(verifyDistributionPlanBinding(plan)).rejects.toMatchObject({ status: 503 });
  });
  it("requires funder ownership and signed exact context before accessing RPC or DB", async () => {
    await expect(prepareDistributionPlan(B, plan, plan.batches[0].entries)).rejects.toMatchObject({ status: 403 });
    await expect(prepareDistributionPlan(A, { ...plan, total_amount: 100 }, plan.batches[0].entries)).rejects.toMatchObject({ status: 400 });
    await expect(prepareDistributionPlan(A, { ...plan, plan_hash: "0".repeat(64) }, plan.batches[0].entries)).rejects.toMatchObject({ status: 400 });
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("atomically prepares before the distribution exists and can recover the exact funded plan", async () => {
    mocks.read.mockResolvedValueOnce({ context: { slot: 123 }, value: [shareClass(), mint(), null] });
    const saved = await prepareDistributionPlan(A, plan, plan.batches[0].entries); expect(saved.status).toBe("prepared");
    expect(mocks.rpc.mock.calls[0][0]).toBe("prepare_distribution_plan");
    mocks.read.mockResolvedValueOnce({ context: { slot: 123 }, value: [shareClass(), mint(), distribution()] });
    await expect(prepareDistributionPlan(A, plan, plan.batches[0].entries)).resolves.toMatchObject({ id: ID });
  });
  it("rejects substituted payment mint ownership before durable preparation", async () => {
    const wrongMint = mint(); wrongMint.owner = ASSET_REGISTRY_PROGRAM_ADDRESS;
    mocks.read.mockResolvedValue({ context: { slot: 123 }, value: [shareClass(), wrongMint, null] });
    await expect(prepareDistributionPlan(A, plan, plan.batches[0].entries)).rejects.toMatchObject({ status: 409 }); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("checks every saved original batch before giving admin executors the plan", async () => {
    expect((await readDistributionPlan(ID)).batches).toEqual(plan.batches);
    mocks.query.mockImplementation((table, filters) => table === "distribution_plan_batches" ? { data: [{ ...plan.batches[0], entries: [plan.batches[0].entries[0]] }], error: null } : query(table, filters));
    await expect(readDistributionPlan(ID)).rejects.toMatchObject({ status: 503 });
  });
  it("returns only the signer's recipient amount and a verified receipt, including after close", async () => {
    mocks.read.mockResolvedValueOnce({ context: { slot: 123 }, value: [distribution({ status: DistributionStatus.Closed }), committed(), shareClass(), mint()] }).mockResolvedValueOnce({ context: { slot: 124 }, value: [receipt()] });
    mocks.verify.mockResolvedValue({ wallet: A, params: { plan_id: ID, wallet: B } });
    const response = await selfProof(req()); expect(response.status).toBe(200); const result = (await response.json()).data;
    expect(result).toMatchObject({ amount: "40", paid: true, checked_slot: "124" }); expect(result).not.toHaveProperty("entries"); expect(result).not.toHaveProperty("proof");
    expect(mocks.filters).toContainEqual(["distribution_plan_batches", "entries", [{ token_owner: A }]]); expect(mocks.filters).toContainEqual(["distribution_plan_metadata", "network", "devnet"]);
    expect(mocks.read.mock.calls[1][1].minContextSlot).toBe(BigInt(123));
  });
  it("does not mistake an absent receipt for a completed batch or stale snapshot for absence", async () => {
    mocks.read.mockResolvedValueOnce({ context: { slot: 123 }, value: [distribution(), committed(), shareClass(), mint()] }).mockResolvedValueOnce({ context: { slot: 123 }, value: [null] });
    await expect(readDistributionSelfProof(A, ID)).resolves.toMatchObject({ paid: false });
    mocks.read.mockResolvedValueOnce({ context: { slot: 123 }, value: [distribution(), committed(), shareClass(), mint()] }).mockResolvedValueOnce({ context: { slot: 122 }, value: [null] });
    await expect(readDistributionSelfProof(A, ID)).rejects.toMatchObject({ status: 503 });
  });
  it("rejects a non-member before chain access and a mismatched immutable receipt", async () => {
    mocks.query.mockImplementation((table, filters) => filters.some((f: unknown[]) => f[0] === "contains") ? { data: null, error: null } : query(table, filters));
    await expect(readDistributionSelfProof(A, ID)).rejects.toMatchObject({ status: 404 }); expect(mocks.read).not.toHaveBeenCalled();
    mocks.query.mockImplementation(query);
    mocks.read.mockResolvedValueOnce({ context: { slot: 123 }, value: [distribution(), committed(), shareClass(), mint()] }).mockResolvedValueOnce({ context: { slot: 123 }, value: [receipt({ totalAmount: 91 })] });
    await expect(readDistributionSelfProof(A, ID)).rejects.toMatchObject({ status: 409 });
  });
});
describe("distribution snapshot API authorization", () => {
  it.each([prepareRoute, bindRoute, adminRead])("requires a current admin before accessing plans", async (route) => {
    mocks.admin.mockRejectedValue(new SiwsError(403, "Admin required")); expect((await route(req({ plan_entries: plan.batches[0].entries }))).status).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("caps streamed request bodies and binds all entries to the signed prepare action", async () => {
    expect((await prepareRoute(req({ large: "x".repeat(2_000_000) }))).status).toBe(413); expect(mocks.admin).not.toHaveBeenCalled();
    mocks.read.mockResolvedValueOnce({ context: { slot: 123 }, value: [shareClass(), mint(), null] });
    expect((await prepareRoute(req({ plan_entries: plan.batches[0].entries }))).status).toBe(200); expect(mocks.verify.mock.calls[0][1]).toBe("distribution-plans.prepare");
  });
});
