import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ read: vi.fn(), rpc: vi.fn(), query: vi.fn(), verify: vi.fn(), admin: vi.fn(), filters: [] as unknown[][] }));
vi.mock("@/lib/network", () => ({ detectNetwork: () => "devnet" }));
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => ({ getMultipleAccounts: (...args: unknown[]) => ({ send: (options: unknown) => mocks.read(...args, options) }) }) }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({
  rpc: (name: string, args: unknown) => ({ abortSignal: () => mocks.rpc(name, args) }),
  from: (table: string) => {
    const filters: unknown[][] = []; const result = () => Promise.resolve(mocks.query(table, filters));
    const q = { select: () => q, order: () => q, limit: () => q, range: () => q, abortSignal: () => q,
      eq: (...args: unknown[]) => { filters.push(args); mocks.filters.push([table, ...args]); return q; },
      maybeSingle: result, then: (resolve: (value: unknown) => unknown) => result().then(resolve) };
    return q;
  },
}) }));
vi.mock("@/lib/server/admin-gate", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/server/siws", async (original) => ({ ...await original<typeof import("@/lib/server/siws")>(), verifySigned: mocks.verify }));
import { address } from "@solana/kit";
import { ASSET_REGISTRY_PROGRAM_ADDRESS, findVaultPda, getPayoutVaultEncoder, getVaultVoteEncoder, PayoutVaultState, VaultVoteOutcome } from "@/lib/generated/asset_registry";
import { canonicalPayoutSnapshot, snapshotBytes } from "@/lib/payout-snapshots";
import { payoutSnapshotLocator, prepareOriginalPayoutSnapshot, verifyPayoutSnapshotBinding, type SnapshotLocator } from "@/lib/server/payout-snapshots";
import { SiwsError } from "@/lib/server/siws";
import { POST as prepareRoute } from "@/app/api/payout-snapshots/prepare/route";
import { POST as bindRoute } from "@/app/api/payout-snapshots/bind/route";
import { POST as proofRoute } from "@/app/api/payout-snapshots/proof/route";
import { POST as adminRead } from "@/app/api/payout-snapshots/admin-read/route";
const A = address("11111111111111111111111111111111");
const B = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ID = "10000000-0000-4000-8000-000000000001";
const rows = [{ wallet: A, weight: "10" }, { wallet: B, weight: "20" }];
let canonical: Awaited<ReturnType<typeof canonicalPayoutSnapshot>>;
let locator: SnapshotLocator;
const account = (bytes: Uint8Array) => ({ owner: String(ASSET_REGISTRY_PROGRAM_ADDRESS), data: [Buffer.from(bytes).toString("base64"), "base64"] });
function vault(options: { round?: number; total?: number; root?: string; state?: PayoutVaultState } = {}) {
  return account(new Uint8Array(getPayoutVaultEncoder().encode({ sale: A, shareClass: A, paymentMint: A, escrow: A, founder: A, raiseType: 0,
    totalAmount: 100, released: 30, startTs: 1, cliffMonths: 0, vestingMonths: 10, numTranches: 10, trancheAmount: 10, tranchesReleased: 3, updatesPosted: 3, lastUpdateTs: 2,
    founderYieldClaimable: 4, investorYieldPool: 5, investorYieldRoot: options.root ? snapshotBytes(options.root) : new Uint8Array(32), totalWeight: options.total ?? 30,
    state: options.state ?? PayoutVaultState.Frozen, metadataHash: new Uint8Array(32), version: 2, bump: 255, voteRound: options.round ?? 1, votePending: (options.round ?? 1) > 0 })));
}
function vote(root = canonical.root_hex, round = 1) {
  return account(new Uint8Array(getVaultVoteEncoder().encode({ payoutVault: address(locator.target_pda), snapshotRoot: snapshotBytes(root), startTs: 10, endTs: 20, returnWeight: 5, extendWeight: 2, outcome: VaultVoteOutcome.Pending, version: 2, bump: 255, round })));
}
function stored(status = "bound") { return { ...locator, id: ID, status, network: "devnet", rows_hash: canonical.rows_hash, entry_count: 2, bound_slot: status === "bound" ? "123" : null }; }
const req = (body: unknown = {}) => new Request("https://app.test/api/payout-snapshots", { method: "POST", body: JSON.stringify(body) });
beforeEach(async () => {
  vi.clearAllMocks(); mocks.filters.length = 0; canonical = await canonicalPayoutSnapshot(rows);
  locator = { kind: "vault_vote", target_pda: (await findVaultPda({ sale: A }))[0], round: "1", root_hex: canonical.root_hex, total_weight: canonical.total_weight };
  mocks.verify.mockResolvedValue({ wallet: A, params: { ...locator, rows_hash: canonical.rows_hash, snapshot_id: ID } }); mocks.admin.mockResolvedValue(undefined);
  mocks.read.mockResolvedValue({ context: { slot: BigInt(123) }, value: [vault(), vote()] });
  mocks.query.mockImplementation((table) => ({ data: table === "payout_snapshot_metadata" ? stored() : { weight: canonical.entries[0].weight, proof: canonical.entries[0].proof }, error: null }));
  mocks.rpc.mockResolvedValue({ data: stored(), error: null });
});
describe("snapshot chain binding and self-only proof access", () => {
  it("validates finalized program ownership, vote PDA/round, root and total", async () => {
    expect(await verifyPayoutSnapshotBinding(locator)).toEqual({ slot: 123, root: canonical.root_hex, total: "30" });
    expect(mocks.read.mock.calls[0][1]).toMatchObject({ commitment: "finalized" }); expect(mocks.read.mock.calls[0][2].abortSignal).toBeInstanceOf(AbortSignal);
  });
  it.each(["owner", "root", "round", "total", "missing"])("rejects a mismatched on-chain %s", async (field) => {
    const v = vault({ total: field === "total" ? 31 : 30 }); const w = vote(field === "root" ? "1".repeat(64) : canonical.root_hex, field === "round" ? 2 : 1);
    if (field === "owner") w.owner = B;
    mocks.read.mockResolvedValue({ context: { slot: 123 }, value: [v, field === "missing" ? null : w] });
    await expect(verifyPayoutSnapshotBinding(locator)).rejects.toMatchObject({ status: 409 });
  });
  it("rejects malformed context and transport failures without binding", async () => {
    mocks.read.mockResolvedValue({ context: { slot: null }, value: [vault(), vote()] });
    await expect(verifyPayoutSnapshotBinding(locator)).rejects.toMatchObject({ status: 503 });
    mocks.read.mockRejectedValue(new Error("HTTP failure"));
    await expect(verifyPayoutSnapshotBinding(locator)).rejects.toMatchObject({ status: 503 });
  });
  it("rejects unsigned row substitution before any chain or DB access", async () => {
    await expect(prepareOriginalPayoutSnapshot(A, { ...locator, rows_hash: canonical.rows_hash }, [{ wallet: A, weight: "30" }])).rejects.toMatchObject({ status: 400 });
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("durably prepares original entries before the next on-chain vote exists", async () => {
    mocks.read.mockResolvedValue({ context: { slot: 123 }, value: [vault({ round: 0, total: 0 })] });
    mocks.rpc.mockResolvedValue({ data: stored("prepared"), error: null });
    const result = await prepareOriginalPayoutSnapshot(A, { ...locator, rows_hash: canonical.rows_hash }, rows);
    expect(result.status).toBe("prepared"); expect(mocks.rpc.mock.calls[0]).toEqual(["prepare_payout_snapshot", { p_snapshot: { ...locator, network: "devnet", rows_hash: canonical.rows_hash, entry_count: 2, created_by: A }, p_entries: canonical.entries }]);
  });
  it("preserves the already committed original yield root instead of adopting new holders", async () => {
    mocks.read.mockResolvedValue({ context: { slot: 123 }, value: [vault({ root: "1".repeat(64), state: PayoutVaultState.Active })] });
    await expect(prepareOriginalPayoutSnapshot(A, { ...locator, kind: "investor_yield", round: "0", rows_hash: canonical.rows_hash }, rows)).rejects.toMatchObject({ status: 409 }); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("returns only the signer’s original proof despite a supplied wallet parameter", async () => {
    mocks.verify.mockResolvedValue({ wallet: A, params: { ...locator, wallet: B } });
    const response = await proofRoute(req()); expect(response.status).toBe(200);
    const data = (await response.json()).data; expect(data.weight).toBe("10"); expect(data).not.toHaveProperty("wallet"); expect(data).not.toHaveProperty("entries");
    expect(mocks.filters).toContainEqual(["payout_snapshot_proofs", "wallet", A]); expect(mocks.filters).not.toContainEqual(["payout_snapshot_proofs", "wallet", B]);
    expect(mocks.filters).toContainEqual(["payout_snapshot_metadata", "network", "devnet"]);
  });
  it("rejects non-members and tampered stored proofs without disclosure", async () => {
    mocks.query.mockImplementation((table) => ({ data: table === "payout_snapshot_metadata" ? stored() : null, error: null }));
    expect((await proofRoute(req())).status).toBe(404); expect(mocks.read).not.toHaveBeenCalled();
    mocks.query.mockImplementation((table) => ({ data: table === "payout_snapshot_metadata" ? stored() : { weight: "11", proof: canonical.entries[0].proof }, error: null }));
    expect((await proofRoute(req())).status).toBe(503);
  });
  it("repairs a lost post-transaction bind only after recipient membership and finalized proof", async () => {
    mocks.query.mockImplementation((table) => ({ data: table === "payout_snapshot_metadata" ? stored("prepared") : canonical.entries[0], error: null }));
    expect((await proofRoute(req())).status).toBe(200);
    expect(mocks.rpc.mock.calls[0]).toEqual(["bind_payout_snapshot", { p_id: ID, p_network: "devnet", p_root: canonical.root_hex, p_total: "30", p_slot: 123 }]);
  });
});
describe("signed admin preparation and review", () => {
  it.each([prepareRoute, bindRoute, adminRead])("denies non-admin callers before writing/reading snapshots", async (route) => {
    mocks.admin.mockRejectedValue(new SiwsError(403, "Admin required"));
    expect((await route(req({ snapshot_rows: rows }))).status).toBe(403); expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled();
  });
  it("provides complete original entries only after admin and content integrity checks", async () => {
    mocks.query.mockImplementation((table) => ({ data: table === "payout_snapshot_metadata" ? stored() : canonical.rows, error: null }));
    const response = await adminRead(req()); expect(response.status).toBe(200);
    expect((await response.json()).data.entries).toEqual(canonical.rows);
    expect(mocks.filters).toContainEqual(["payout_snapshot_metadata", "network", "devnet"]);
    mocks.query.mockImplementation((table) => ({ data: table === "payout_snapshot_metadata" ? stored() : [canonical.rows[0]], error: null }));
    expect((await adminRead(req())).status).toBe(503);
  });
  it("uses the digest-signed preparation action and rejects large streamed requests", async () => {
    mocks.read.mockResolvedValue({ context: { slot: 123 }, value: [vault({ round: 0, total: 0 })] });
    const response = await prepareRoute(req({ snapshot_rows: rows })); expect(response.status).toBe(200);
    expect(mocks.verify.mock.calls[0][1]).toBe("payout-snapshots.prepare");
    expect((await prepareRoute(req({ large: "x".repeat(1_000_000) }))).status).toBe(413);
  });
});

describe("no v1 payout path after 2E", () => {
  it("the locator rejects the retired legacy_vault_vote kind with 400", () => {
    let caught: unknown;
    try { payoutSnapshotLocator({ ...locator, kind: "legacy_vault_vote", round: "0" }); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(SiwsError); expect(caught).toMatchObject({ status: 400 });
  });
  it("a stored legacy_vault_vote row is rejected with 409 before any chain read", async () => {
    const legacy = { ...locator, kind: "legacy_vault_vote", round: "0" } as unknown as SnapshotLocator;
    await expect(verifyPayoutSnapshotBinding(legacy)).rejects.toMatchObject({ status: 409 });
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([["physically shorter", true], ["padded", false]])("rejects %s v1 vault bytes with 409", async (_label, shorter) => {
    const bytes = Buffer.from(vault({ state: PayoutVaultState.Cancelled }).data[0], "base64"); bytes[bytes.length - 11] = 1;
    const v1 = account(new Uint8Array(shorter ? bytes.subarray(0, -9) : bytes));
    mocks.read.mockResolvedValue({ context: { slot: 123 }, value: [v1, vote()] });
    await expect(verifyPayoutSnapshotBinding(locator)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Unsupported PayoutVault version 1/) });
    mocks.read.mockResolvedValue({ context: { slot: 123 }, value: [v1] });
    await expect(prepareOriginalPayoutSnapshot(A, { ...locator, rows_hash: canonical.rows_hash }, rows)).rejects.toMatchObject({ status: 409 });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
