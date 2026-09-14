import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ multiple: vi.fn(), program: vi.fn(), rpc: vi.fn(), pages: vi.fn(), states: vi.fn(), filters: [] as unknown[][] }));
vi.mock("@/lib/network", () => ({ detectNetwork: () => "devnet" }));
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => ({
  getMultipleAccounts: (...args: unknown[]) => ({ send: (opts: unknown) => mocks.multiple(...args, opts) }),
  getProgramAccounts: (...args: unknown[]) => ({ send: (opts: unknown) => mocks.program(...args, opts) }),
}) }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({
  rpc: (name: string, args: unknown) => ({ abortSignal: (signal: AbortSignal) => mocks.rpc(name, args, signal) }),
  from: (table: string) => {
    let after: string | null = null; let payload: unknown;
    const q = {
      select: () => q, order: () => q, limit: () => q,
      eq: (...args: unknown[]) => { mocks.filters.push([table, ...args]); return q; },
      gt: (_column: string, value: string) => { after = value; return q; },
      upsert: (value: unknown) => { payload = value; return q; },
      abortSignal: (signal: AbortSignal) => table === "indexer_sync_state" ? mocks.states(payload, signal) : mocks.pages(table, after, signal),
    }; return q;
  },
}) }));
import { decodeIndexerAccount, INDEXER_ENTITIES, INDEXER_PROGRAM } from "@/lib/server/indexer-accounts";
import { reconcileAllIndexerAccounts, reconcileIndexerJobs, refreshIndexedAddresses } from "@/lib/server/indexer-sync";
import { indexerFixtures } from "./helpers/indexer-fixtures";
import { getAddressDecoder } from "@solana/kit";
async function snapshots() {
  return Promise.all(indexerFixtures().map(async (f) => {
    const row = await INDEXER_ENTITIES.find((e) => e.table === f.table)!.decode(f.bytes);
    return { pubkey: String(row.pda), account: { owner: String(INDEXER_PROGRAM), data: [Buffer.from(f.bytes).toString("base64"), "base64"] } };
  }));
}
const deadline = () => Date.now() + 30_000;
const applied = () => mocks.rpc.mock.calls.filter(([name]) => name === "apply_indexer_snapshot");
beforeEach(() => {
  vi.resetAllMocks(); mocks.filters.length = 0;
  mocks.pages.mockResolvedValue({ data: [], error: null }); mocks.states.mockResolvedValue({ error: null });
  mocks.rpc.mockImplementation(async (name, args) => name === "apply_indexer_snapshot" ? { data: { written: args.p_rows.length, closed: args.p_closed.length, stale: 0, applied: args.p_rows.map((v: { row: { pda: string } }) => v.row.pda), deleted: {} }, error: null } : { data: true, error: null });
});
describe("finalized indexer snapshots and retries", () => {
  it("uses finalized context slot and minContextSlot, never the webhook slot as snapshot provenance", async () => {
    const [snapshot] = await snapshots(); mocks.multiple.mockResolvedValue({ context: { slot: BigInt(55) }, value: [snapshot.account] });
    await refreshIndexedAddresses([snapshot.pubkey], 3, "signature", deadline());
    expect(mocks.multiple.mock.calls[0][1]).toEqual({ commitment: "finalized", encoding: "base64", minContextSlot: BigInt(3) });
    expect(applied()[0][1]).toMatchObject({ p_slot: 55, p_network: "devnet", p_closed: [], p_signature: "signature" });
    expect(mocks.multiple.mock.calls[0][2].abortSignal).toBeInstanceOf(AbortSignal);
  });
  it.each([undefined, { context: { slot: 10 }, value: [] }, { context: { slot: null }, value: [null] }, { context: { slot: 1 }, value: [null] }, { context: { slot: 10 }, value: [{}] }])("does not turn malformed/incomplete/older RPC responses into closures", async (value) => {
    const [snapshot] = await snapshots(); mocks.multiple.mockResolvedValue(value);
    await expect(refreshIndexedAddresses([snapshot.pubkey], 3, null, deadline())).rejects.toThrow(); expect(applied()).toHaveLength(0);
  });
  it("retains jobs after RPC/HTTP failure without acknowledgement", async () => {
    const [snapshot] = await snapshots(); const job = { id: "job", network: "devnet", signature: "signature", wallets: [snapshot.pubkey], slot: 3 };
    mocks.multiple.mockRejectedValue(new Error("HTTP 429"));
    mocks.rpc.mockImplementation(async (name) => ({ data: name === "claim_indexer_jobs" ? [job] : true, error: null }));
    expect(await reconcileIndexerJobs(1, deadline())).toMatchObject({ complete: 0, pending: 1 });
    expect(applied()).toHaveLength(0);
    expect(mocks.rpc.mock.calls.find(([name]) => name === "finish_indexer_job")?.[1]).toMatchObject({ p_complete: false });
  });
  it("only acknowledges after snapshot write succeeds; schema failure remains pending", async () => {
    const [snapshot] = await snapshots(); const job = { id: "job", network: "devnet", signature: "signature", wallets: [snapshot.pubkey], slot: 3 };
    mocks.multiple.mockResolvedValue({ context: { slot: 55 }, value: [snapshot.account] });
    mocks.rpc.mockImplementation(async (name) => name === "apply_indexer_snapshot" ? { data: null, error: { code: "PGRST204" } } : { data: name === "claim_indexer_jobs" ? [job] : true, error: null });
    expect(await reconcileIndexerJobs(1, deadline())).toMatchObject({ complete: 0, pending: 1 });
    expect(mocks.rpc.mock.calls.find(([name]) => name === "finish_indexer_job")?.[1]).toMatchObject({ p_complete: false });
  });
  it("stops cooperatively at deadline/abort without claiming or acknowledging jobs", async () => {
    const c = new AbortController(); c.abort(); expect(await reconcileIndexerJobs(10, deadline(), c.signal)).toMatchObject({ complete: 0 });
    expect(await reconcileIndexerJobs(10, Date.now() - 1)).toMatchObject({ complete: 0 }); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("full reconciliation reconstructs typed fields for all 14 entities and paginates existing closures beyond 1000", async () => {
    const chain = await snapshots(); mocks.program.mockResolvedValue({ context: { slot: 500 }, value: chain });
    const existing = Array.from({ length: 1001 }, (_, i) => {
      const bytes = new Uint8Array(32); new DataView(bytes.buffer).setUint32(0, i + 5); return { pda: getAddressDecoder().decode(bytes) };
    }).sort((a, b) => a.pda.localeCompare(b.pda));
    mocks.pages.mockImplementation(async (table, after) => ({ data: table === "platforms" ? after === null ? existing.slice(0, 1000) : existing.slice(1000) : [], error: null }));
    const result = await reconcileAllIndexerAccounts(deadline());
    expect(Object.keys(result.report)).toHaveLength(14);
    for (const r of Object.values(result.report)) expect(r).toMatchObject({ onchain: 1, rebuilt: 1 });
    const writes = applied(); expect(writes[0][1].p_rows).toHaveLength(14);
    expect(writes.flatMap(([, args]) => args.p_closed)).toHaveLength(1001);
    expect(mocks.pages.mock.calls.filter(([table]) => table === "platforms")).toHaveLength(2);
    expect(mocks.filters.every(([, col, value]) => col === "network" && value === "devnet")).toBe(true);
    expect(mocks.states.mock.calls.at(-1)?.[0]).toMatchObject({ status: "ready", last_slot: 500 });
  });
  it("validates the entire program response before any typed write or deletion", async () => {
    const chain = await snapshots(); chain[13].account.owner = "11111111111111111111111111111111";
    mocks.program.mockResolvedValue({ context: { slot: 500 }, value: chain });
    await expect(reconcileAllIndexerAccounts(deadline())).rejects.toThrow(/owner/);
    expect(applied()).toHaveLength(0); expect(mocks.pages).not.toHaveBeenCalled(); expect(mocks.states.mock.calls[0][0]).toMatchObject({ status: "degraded" });
  });
  it("ignores skipped stale writes in its reconciliation report", async () => {
    mocks.program.mockResolvedValue({ context: { slot: 500 }, value: await snapshots() });
    mocks.rpc.mockResolvedValue({ data: { written: 0, closed: 0, stale: 14, applied: [], deleted: {} }, error: null });
    const result = await reconcileAllIndexerAccounts(deadline());
    for (const report of Object.values(result.report)) expect(report.rebuilt).toBe(0);
  });
  it("rejects a truncated discriminator for a program-owned snapshot", async () => {
    await expect(decodeIndexerAccount("11111111111111111111111111111111", INDEXER_PROGRAM, new Uint8Array(3))).rejects.toThrow(/discriminator/);
  });
});
