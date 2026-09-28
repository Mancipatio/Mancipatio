// v1.0.0-rc (8.3): the indexer decoders and the complete reconcile for the
// role-state mirror (0079) and the rc.x layouts that left the IDL.
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ multiple: vi.fn(), program: vi.fn(), hook: vi.fn(), rpc: vi.fn(), pages: vi.fn(), states: vi.fn() }));
vi.mock("@/lib/network", () => ({ detectNetwork: () => "devnet" }));
const HOOK_PROGRAM = "GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy";
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => ({
  getMultipleAccounts: (...args: unknown[]) => ({ send: (opts: unknown) => mocks.multiple(...args, opts) }),
  getProgramAccounts: (...args: unknown[]) => ({ send: (opts: unknown) => (args[0] === HOOK_PROGRAM ? mocks.hook : mocks.program)(...args, opts) }),
}) }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({
  rpc: (name: string, args: unknown) => ({ abortSignal: () => mocks.rpc(name, args) }),
  from: (table: string) => {
    let payload: unknown;
    const q = {
      select: () => q, order: () => q, limit: () => q, eq: () => q, gt: () => q,
      upsert: (value: unknown) => { payload = value; return q; },
      abortSignal: () => table === "indexer_sync_state" ? mocks.states(payload) : mocks.pages(table),
    }; return q;
  },
}) }));

import { address, getBase58Encoder } from "@solana/kit";
import {
  ALL_INDEXER_ENTITIES,
  INDEXER_ENTITIES,
  INDEXER_HOOK_PROGRAM,
  INDEXER_PROGRAM,
  ROLE_STATE_ENTITIES,
  decodeIndexerAccount,
} from "@/lib/server/indexer-accounts";
import { reconcileAllIndexerAccounts, refreshIndexedAddresses } from "@/lib/server/indexer-sync";
import { LEGACY_AUTHORITY_TRANSFER, LEGACY_BLOCKLIST_AUTHORITY_TRANSFER } from "@/lib/legacy-accounts";
import {
  findAuthorityProposalPda,
  findBlocklistAuthorityProposalPda,
  findBlocklistRecoveryPda,
  findIssuerFreezePda,
  findPendingAdminPda,
  findPlatformRecoveryPda,
} from "@/lib/pdas";
import { findAcceptPlatformAdminRecoveryPda, findPlatformPda } from "@/lib/generated/asset_registry";
import { getBlockEntryEncoder, getBlocklistAuthorityEncoder } from "@/lib/generated/transfer_hook";
import { indexerFixtures, roleStateFixtures } from "./helpers/indexer-fixtures";

const KEY = address("11111111111111111111111111111111");
const OTHER = address("SysvarC1ock11111111111111111111111111111111");
const THIRD = address("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
const b64 = (bytes: Uint8Array) => [Buffer.from(bytes).toString("base64"), "base64"];
const entity = (table: string) => ALL_INDEXER_ENTITIES.find((e) => e.table === table)!;
const deadline = () => Date.now() + 30_000;
const applied = () => mocks.rpc.mock.calls.filter(([name]) => name === "apply_indexer_snapshot").map(([, args]) => args);

/** Each role-state fixture with the address its seeds give and its owner. */
async function roleAccounts() {
  const expected: Record<string, string> = {
    issuer_freezes: await findIssuerFreezePda(KEY),
    pending_admins: await findPendingAdminPda(THIRD),
    authority_proposals: await findAuthorityProposalPda(KEY),
    // The fixture's `platform` field is the default key, not the live Platform.
    platform_recoveries: (await findAcceptPlatformAdminRecoveryPda({ platform: KEY }))[0],
    blocklist_authority_proposals: await findBlocklistAuthorityProposalPda(),
    blocklist_recoveries: await findBlocklistRecoveryPda(),
  };
  return Promise.all(roleStateFixtures().map(async (f) => {
    const row = await entity(f.table).decode(f.bytes, null);
    if (expected[f.table]) expect(row.pda, f.table).toBe(expected[f.table]);
    return { table: f.table, pubkey: String(row.pda), bytes: f.bytes, owner: entity(f.table).program, row };
  }));
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.pages.mockResolvedValue({ data: [], error: null });
  mocks.states.mockResolvedValue({ error: null });
  mocks.program.mockResolvedValue({ context: { slot: 500 }, value: [] });
  mocks.hook.mockResolvedValue({ context: { slot: 500 }, value: [] });
  mocks.rpc.mockImplementation(async (name, args) => name === "apply_indexer_snapshot"
    ? { data: { written: args.p_rows.length, closed: args.p_closed.length, stale: 0, applied: args.p_rows.map((v: { row: { pda: string } }) => v.row.pda), deleted: {} }, error: null }
    : { data: true, error: null });
});

describe("role-state decoders (0079)", () => {
  it("are six fixed-size generated layouts, four registry-owned and two hook-owned, apart from the 14 market mirrors", () => {
    expect(ROLE_STATE_ENTITIES.map((e) => [e.table, e.program === INDEXER_PROGRAM ? "registry" : "hook", e.size])).toEqual([
      ["issuer_freezes", "registry", 114],
      ["pending_admins", "registry", 98],
      ["authority_proposals", "registry", 163],
      ["platform_recoveries", "registry", 162],
      ["blocklist_authority_proposals", "hook", 89],
      ["blocklist_recoveries", "hook", 129],
    ]);
    expect(INDEXER_ENTITIES).toHaveLength(14);
    expect(ALL_INDEXER_ENTITIES.map((e) => e.table)).toEqual([...INDEXER_ENTITIES, ...ROLE_STATE_ENTITIES].map((e) => e.table));
    expect(INDEXER_HOOK_PROGRAM).toBe(HOOK_PROGRAM);
  });

  it("project every field at the address the generated PDA helpers derive, for their own owner only", async () => {
    const accounts = await roleAccounts();
    // The live Platform's recovery PDA is the same helper over the Platform PDA.
    expect(await findPlatformRecoveryPda()).toBe((await findAcceptPlatformAdminRecoveryPda({ platform: (await findPlatformPda())[0] }))[0]);
    for (const a of accounts) {
      expect(await decodeIndexerAccount(a.pubkey, a.owner, a.bytes), a.table).toEqual({ table: a.table, row: a.row });
      // The other program never owns this layout: not mirrored.
      const foreign = a.owner === INDEXER_PROGRAM ? INDEXER_HOOK_PROGRAM : INDEXER_PROGRAM;
      expect(await decodeIndexerAccount(a.pubkey, foreign, a.bytes), a.table).toBeNull();
      // At any other address the derived PDA disagrees.
      await expect(decodeIndexerAccount(KEY, a.owner, a.bytes), a.table).rejects.toThrow(/derived PDA/);
    }
    const [freeze, pending, proposal, recovery, baProposal, baRecovery] = accounts.map((a) => a.row);
    expect(freeze).toMatchObject({ issuer_pda: KEY, frozen_by: OTHER, frozen_at: "1234", reason_hash: "07".repeat(32), account_version: 1 });
    expect(pending).toMatchObject({ new_admin: THIRD, proposed_by: OTHER, proposed_at: "1000", eta: "2000", expires_at: "3000" });
    expect(proposal).toMatchObject({ target: KEY, kind: 0, current_authority: OTHER, new_authority: THIRD, eta: "2000" });
    expect(recovery).toMatchObject({ platform_pda: KEY, current_admin: OTHER, new_admin: THIRD, proposed_by: KEY, eta: "2000" });
    expect(baProposal).toMatchObject({ current_authority: OTHER, new_authority: THIRD, proposed_at: "1000", expires_at: "3000", account_version: 0 });
    expect(baRecovery).toMatchObject({ current_authority: OTHER, new_authority: THIRD, proposed_by: KEY, eta: "2000", account_version: 0 });
  });

  it("refuse any size but the exact layout (IDL drift), and a version other than 1", async () => {
    for (const a of await roleAccounts()) {
      const longer = new Uint8Array(a.bytes.length + 1); longer.set(a.bytes);
      await expect(decodeIndexerAccount(a.pubkey, a.owner, longer), a.table).rejects.toThrow(/exactly/);
      await expect(decodeIndexerAccount(a.pubkey, a.owner, a.bytes.slice(0, -1)), a.table).rejects.toThrow();
    }
    const [freeze] = await roleAccounts();
    const v2 = freeze.bytes.slice(); v2[112] = 2; // version byte of IssuerFreeze
    await expect(decodeIndexerAccount(freeze.pubkey, freeze.owner, v2)).rejects.toThrow(/version 2/);
  });

  it("leave the hook's other accounts unmirrored, and never throw on a short hook account", async () => {
    const block = new Uint8Array(getBlockEntryEncoder().encode({ wallet: KEY, addedBy: OTHER, bump: 255 }));
    const ba = new Uint8Array(getBlocklistAuthorityEncoder().encode({ authority: KEY, bump: 255 }));
    for (const bytes of [block, ba, new Uint8Array(3)]) expect(await decodeIndexerAccount(KEY, INDEXER_HOOK_PROGRAM, bytes)).toBeNull();
  });

  it("recognise the rc.x AuthorityTransfer (137 B) and BlocklistAuthorityTransfer (73 B) as known, unmirrored layouts", async () => {
    const legacy = (l: typeof LEGACY_AUTHORITY_TRANSFER) => { const b = new Uint8Array(l.size); b.set(l.discriminator); return b; };
    expect(await decodeIndexerAccount(KEY, INDEXER_PROGRAM, legacy(LEGACY_AUTHORITY_TRANSFER))).toBeNull();
    expect(await decodeIndexerAccount(KEY, INDEXER_HOOK_PROGRAM, legacy(LEGACY_BLOCKLIST_AUTHORITY_TRANSFER))).toBeNull();
  });
});

describe("jobs and the complete reconcile with the role state", () => {
  it("a job snapshot writes a hook-owned recovery and closes it when the account is gone", async () => {
    const accounts = await roleAccounts();
    const recovery = accounts.find((a) => a.table === "blocklist_recoveries")!;
    mocks.multiple.mockResolvedValueOnce({ context: { slot: BigInt(80) }, value: [{ owner: HOOK_PROGRAM, data: b64(recovery.bytes) }] });
    await refreshIndexedAddresses([recovery.pubkey], 3, "signature", deadline());
    expect(applied()[0]).toMatchObject({ p_slot: 80, p_closed: [], p_rows: [{ table: "blocklist_recoveries", row: { pda: recovery.pubkey } }] });
    mocks.multiple.mockResolvedValueOnce({ context: { slot: BigInt(81) }, value: [null] });
    await refreshIndexedAddresses([recovery.pubkey], 3, "signature", deadline());
    expect(applied()[1]).toMatchObject({ p_slot: 81, p_rows: [], p_closed: [recovery.pubkey] });
  });

  it("scans the hook by layout at finalized, no older than the registry snapshot, and applies each group at its own slot", async () => {
    const accounts = await roleAccounts();
    const registry = accounts.filter((a) => a.owner === INDEXER_PROGRAM);
    const hook = accounts.filter((a) => a.owner === INDEXER_HOOK_PROGRAM);
    const legacyTransfer = new Uint8Array(LEGACY_AUTHORITY_TRANSFER.size); legacyTransfer.set(LEGACY_AUTHORITY_TRANSFER.discriminator);
    const legacyHook = new Uint8Array(LEGACY_BLOCKLIST_AUTHORITY_TRANSFER.size); legacyHook.set(LEGACY_BLOCKLIST_AUTHORITY_TRANSFER.discriminator);
    const market = await Promise.all(indexerFixtures().map(async (f) => ({
      pubkey: String((await entity(f.table).decode(f.bytes, f.address)).pda), account: { owner: INDEXER_PROGRAM, data: b64(f.bytes) },
    })));
    mocks.program.mockResolvedValue({ context: { slot: 500 }, value: [
      ...market,
      ...registry.map((a) => ({ pubkey: a.pubkey, account: { owner: INDEXER_PROGRAM, data: b64(a.bytes) } })),
      { pubkey: THIRD, account: { owner: INDEXER_PROGRAM, data: b64(legacyTransfer) } },
    ] });
    const disc = (cfg: { filters: { memcmp?: { bytes: string } }[] }) =>
      Array.from(getBase58Encoder().encode(cfg.filters[0].memcmp!.bytes));
    mocks.hook.mockImplementation(async (_program: string, cfg: { filters: { memcmp?: { bytes: string }; dataSize?: bigint }[] }) => {
      const want = disc(cfg);
      const size = Number(cfg.filters[1].dataSize);
      const match = hook.find((a) => a.bytes.length === size && Array.from(a.bytes.slice(0, 8)).join() === want.join());
      if (match) return { context: { slot: 510 }, value: [{ pubkey: match.pubkey, account: { owner: HOOK_PROGRAM, data: b64(match.bytes) } }] };
      if (size === LEGACY_BLOCKLIST_AUTHORITY_TRANSFER.size) return { context: { slot: 511 }, value: [{ pubkey: OTHER, account: { owner: HOOK_PROGRAM, data: b64(legacyHook) } }] };
      return { context: { slot: 510 }, value: [] };
    });
    // An existing row of a role-state table whose account is gone.
    mocks.pages.mockImplementation(async (table: string) => ({ data: table === "pending_admins" ? [{ pda: KEY }] : [], error: null }));
    const result = await reconcileAllIndexerAccounts(deadline());
    // Every hook scan: finalized, at least the registry slot, discriminator + exact size.
    for (const [, cfg] of mocks.hook.mock.calls) {
      expect(cfg).toMatchObject({ commitment: "finalized", encoding: "base64", withContext: true, minContextSlot: BigInt(500) });
      expect(cfg.filters).toHaveLength(2);
    }
    expect(mocks.hook).toHaveBeenCalledTimes(3);
    expect(Object.keys(result.report)).toHaveLength(20);
    for (const e of ROLE_STATE_ENTITIES) expect(result.report[e.table], e.table).toMatchObject({ onchain: 1, rebuilt: 1 });
    expect(result.report.pending_admins.deleted).toBe(0); // the mock reports no deletions; the closure below is what was sent
    const writes = applied();
    expect(writes[0]).toMatchObject({ p_slot: 500 });
    expect(writes[0].p_rows).toHaveLength(14 + 4);
    expect(writes.filter((w) => w.p_slot === 510 && w.p_rows.length === 1)).toHaveLength(2);
    expect(writes.find((w) => w.p_closed.length)).toMatchObject({ p_slot: 500, p_closed: [KEY] });
    expect(result.legacy).toEqual([
      { address: THIRD, program: "asset_registry", type: "AuthorityTransfer", size: 137 },
      { address: OTHER, program: "transfer_hook", type: "BlocklistAuthorityTransfer", size: 73 },
    ]);
  });

  it("refuses a hook snapshot with a foreign owner, older than the registry, or a row of the wrong layout", async () => {
    mocks.hook.mockResolvedValueOnce({ context: { slot: 500 }, value: [{ pubkey: KEY, account: { owner: INDEXER_PROGRAM, data: b64(new Uint8Array(89)) } }] });
    await expect(reconcileAllIndexerAccounts(deadline())).rejects.toThrow(/unexpected account owner/);
    mocks.hook.mockResolvedValueOnce({ context: { slot: 499 }, value: [] });
    await expect(reconcileAllIndexerAccounts(deadline())).rejects.toThrow(/older/);
    mocks.hook.mockResolvedValueOnce({ context: { slot: 500 }, value: [{ pubkey: KEY, account: { owner: HOOK_PROGRAM, data: b64(new Uint8Array(89)) } }] });
    await expect(reconcileAllIndexerAccounts(deadline())).rejects.toThrow(/not a blocklist_authority_proposals row/);
    expect(applied()).toHaveLength(0);
    expect(mocks.states.mock.calls.every(([state]) => (state as { status: string }).status === "degraded")).toBe(true);
  });
});
