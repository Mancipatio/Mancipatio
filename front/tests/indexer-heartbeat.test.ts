// The indexer freshness heartbeat (0075): the evidence it gathers, how it
// pages, and that it fails closed and never throws. The SQL that decides runs
// for real in indexer-heartbeat.postgres.test.ts; here RPC and Supabase are fakes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  slot: vi.fn(), sigs: vi.fn(), multiple: vi.fn(), tx: vi.fn(), db: vi.fn(), admin: vi.fn(),
}));
vi.mock("@/lib/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/network")>()),
  detectNetwork: () => "devnet",
}));
vi.mock("@/lib/server/maintenance", () => ({ readMaintenance: async () => ({ enabled: false, fresh: true }) }));
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => ({
  getSlot: (config: unknown) => ({ send: (opts: unknown) => mocks.slot(config, opts) }),
  getSignaturesForAddress: (account: string, config: unknown) => ({ send: (opts: unknown) => mocks.sigs(account, config, opts) }),
  getMultipleAccounts: (keys: string[], config: unknown) => ({ send: (opts: unknown) => mocks.multiple(keys, config, opts) }),
  getTransaction: (sig: string, config: unknown) => ({ send: (opts: unknown) => mocks.tx(sig, config, opts) }),
}) }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => mocks.admin() }));

import { getBase58Decoder } from "@solana/kit";
import { ASSET_REGISTRY_PROGRAM_ADDRESS } from "@/lib/generated/asset_registry";
import { TRANSFER_HOOK_PROGRAM_ADDRESS } from "@/lib/generated/transfer_hook";
import { HEARTBEAT, HEARTBEAT_PROGRAMS, parsePlan, runIndexerHeartbeat } from "@/lib/server/indexer-heartbeat";
import { buildTx } from "./helpers/chain-tx";

const AR = ASSET_REGISTRY_PROGRAM_ADDRESS as string;
const TH = TRANSFER_HOOK_PROGRAM_ADDRESS as string;
const PDA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PLAN_ID = "7b0c5e1e-2f4a-4c8e-9a51-0d2f3b6c9e10";
/** A real 64-byte signature in base58 (the kit `signature()` check accepts it). */
const sig = (n: number) => getBase58Decoder().decode(Uint8Array.from({ length: 64 }, (_, i) => (n * 31 + i * 7 + 1) % 256));
type SigRow = { signature: string; slot: bigint; err: unknown; blockTime: bigint | null; memo: null; confirmationStatus: string };
const row = (n: number, slot: number, err: unknown = null): SigRow =>
  ({ signature: sig(n), slot: BigInt(slot), err, blockTime: BigInt(1_700_000_000), memo: null, confirmationStatus: "confirmed" });
type Call = [string, Record<string, unknown>, { abortSignal?: AbortSignal }];

let plan: Record<string, unknown>;
let lists: Record<string, SigRow[][]>;
const pagesAsked = (): Array<Record<string, unknown>> =>
  (mocks.sigs.mock.calls as Call[]).map(([account, config]) => ({ account, ...config }));
const dbCalls = () => mocks.db.mock.calls.map(([name, args]) => ({ name, args }));
const confirms = () => dbCalls().filter((c) => c.name === "confirm_indexer_quiet").map((c) => c.args as Record<string, unknown>);

beforeEach(() => {
  vi.clearAllMocks();
  plan = {
    mode: "on", due: true, plan_id: PLAN_ID, planned_at: new Date().toISOString(),
    floors: { [AR]: 1_000, [TH]: 1_000 }, resume: { [AR]: null, [TH]: null }, sample: [PDA], probe: [],
  };
  // Quiet: one short page per program whose only row is at the floor.
  lists = { [AR]: [[row(1, 1_000)]], [TH]: [[row(2, 990)]] };
  mocks.admin.mockImplementation(() => ({
    rpc: (name: string, args: unknown) => ({ abortSignal: (signal: AbortSignal) => mocks.db(name, args, signal) }),
  }));
  mocks.db.mockImplementation(async (name: string) => name === "indexer_heartbeat_plan"
    ? { data: plan, error: null }
    : { data: { outcome: "bumped", reason: null, expired: false }, error: null });
  mocks.slot.mockResolvedValue(BigInt(5_000));
  mocks.sigs.mockImplementation(async (account: string, config: { before?: string }) => {
    const pages = lists[account] ?? [];
    const index = config.before ? pages.findIndex((p) => p.some((r) => r.signature === config.before)) + 1 : 0;
    return pages[index] ?? [];
  });
  mocks.multiple.mockImplementation(async (keys: string[]) => ({
    context: { slot: BigInt(4_960) },
    value: keys.map(() => ({ owner: AR, data: ["AAECAw==", "base64"], executable: false, lamports: BigInt(1), space: BigInt(4) })),
  }));
  mocks.tx.mockResolvedValue(null);
});
afterEach(() => { vi.restoreAllMocks(); });

const deadline = (ms = 15_000) => Date.now() + ms;

describe("a quiet run", () => {
  it("reads the tip, both listings and the sample, and hands the evidence to confirm_indexer_quiet", async () => {
    expect(await runIndexerHeartbeat(deadline())).toEqual({ status: "bumped" });
    expect(dbCalls().map((c) => c.name)).toEqual(["indexer_heartbeat_plan", "confirm_indexer_quiet"]);
    expect(dbCalls()[0].args).toEqual({ p_network: "devnet" });
    expect(mocks.slot).toHaveBeenCalledWith({ commitment: "confirmed" }, expect.objectContaining({ abortSignal: expect.any(AbortSignal) }));
    expect(pagesAsked()).toEqual([
      { account: AR, commitment: "confirmed", limit: 20, minContextSlot: BigInt(4_925) },
      { account: TH, commitment: "confirmed", limit: 20, minContextSlot: BigInt(4_925) },
    ]);
    expect(mocks.multiple).toHaveBeenCalledWith([PDA], { encoding: "base64", commitment: "finalized", minContextSlot: BigInt(1_000) },
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }));
    expect(mocks.tx).not.toHaveBeenCalled();
    expect(confirms()[0]).toEqual({
      p_network: "devnet", p_plan_id: PLAN_ID, p_client_reason: null, p_tip_slot: 5_000,
      p_listings: [
        { program: AR, before: null, rows: [{ signature: sig(1), slot: 1_000, ok: true }] },
        { program: TH, before: null, rows: [{ signature: sig(2), slot: 990, ok: true }] },
      ],
      p_sample: { context_slot: 4_960, accounts: [{ pda: PDA, owner: AR, data: "AAECAw==" }] },
      p_exempt: [],
    });
  });

  it("lists both programs and reads the sample in parallel, after the tip", async () => {
    let inFlight = 0; let peak = 0;
    const slow = async <T>(value: T) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight--; return value;
    };
    mocks.sigs.mockImplementation(async (account: string) => slow((lists[account] ?? [[]])[0]));
    const multiple = mocks.multiple.getMockImplementation()!;
    mocks.multiple.mockImplementation(async (keys: string[], config: unknown, opts: unknown) => slow(await multiple(keys, config, opts)));
    await runIndexerHeartbeat(deadline());
    expect(peak).toBe(3);
    expect(mocks.slot.mock.invocationCallOrder[0]).toBeLessThan(mocks.sigs.mock.invocationCallOrder[0]);
  });

  it("maps every verdict; the expiry flag travels with a decline", async () => {
    mocks.db.mockImplementation(async (name: string) => name === "indexer_heartbeat_plan" ? { data: plan, error: null }
      : { data: { outcome: "would_bump", reason: null, expired: false }, error: null });
    expect(await runIndexerHeartbeat(deadline())).toEqual({ status: "would_bump" });
    mocks.db.mockImplementation(async (name: string) => name === "indexer_heartbeat_plan" ? { data: plan, error: null }
      : { data: { outcome: "declined", reason: "UNINDEXED_SIGNATURE", expired: true }, error: null });
    expect(await runIndexerHeartbeat(deadline())).toEqual({ status: "declined", reason: "UNINDEXED_SIGNATURE", expired: true });
    for (const bad of [null, { outcome: "declined", reason: "not a code" }, { outcome: "maybe" }]) {
      mocks.db.mockImplementation(async (name: string) => name === "indexer_heartbeat_plan" ? { data: plan, error: null } : { data: bad, error: null });
      expect(await runIndexerHeartbeat(deadline())).toEqual({ status: "declined", reason: "DB_ERROR" });
    }
    mocks.db.mockImplementation(async (name: string) => name === "indexer_heartbeat_plan" ? { data: plan, error: null }
      : { data: null, error: { code: "22023", message: "Invalid heartbeat evidence" } });
    expect(await runIndexerHeartbeat(deadline())).toEqual({ status: "declined", reason: "DB_ERROR" });
  });
});

describe("listings", () => {
  it("pages 20 then 100 with `before` until a row reaches the floor; failed rows are sent with ok = false", async () => {
    const first = Array.from({ length: 20 }, (_, i) => row(100 + i, 3_000 - i));
    const second = [row(200, 2_500, { InstructionError: [0, "Custom"] }), ...Array.from({ length: 98 }, (_, i) => row(201 + i, 2_400 - i)), row(299, 999)];
    lists[AR] = [first, second];
    await runIndexerHeartbeat(deadline());
    expect(pagesAsked().filter((p) => p.account === AR)).toEqual([
      { account: AR, commitment: "confirmed", limit: 20, minContextSlot: BigInt(4_925) },
      { account: AR, commitment: "confirmed", limit: 100, minContextSlot: BigInt(4_925), before: first[19].signature },
    ]);
    const listing = (confirms()[0].p_listings as { program: string; rows: { signature: string; ok: boolean }[] }[])[0];
    expect(listing.rows).toHaveLength(120);
    expect(listing.rows[20]).toEqual({ signature: sig(200), slot: 2_500, ok: false });
    expect(listing.rows.at(-1)).toEqual({ signature: sig(299), slot: 999, ok: true });
  });

  it("stops at a short page (the SQL decides whether it reached the floor) and after 3 pages", async () => {
    lists[AR] = [Array.from({ length: 5 }, (_, i) => row(10 + i, 3_000 - i))];
    await runIndexerHeartbeat(deadline());
    expect(pagesAsked().filter((p) => p.account === AR)).toHaveLength(1);
    mocks.sigs.mockClear();
    const page = (base: number, n: number) => Array.from({ length: n }, (_, i) => row(base + i, 4_000 - base - i));
    lists[AR] = [page(0, 20), page(20, 100), page(120, 100), page(220, 100)];
    await runIndexerHeartbeat(deadline());
    expect(pagesAsked().filter((p) => p.account === AR).map((p) => p.limit)).toEqual([20, 100, 100]);
    expect((confirms().at(-1)!.p_listings as { rows: unknown[] }[])[0].rows).toHaveLength(220);
  });

  it("continues from the plan's cursor (100 per page, `before` = cursor) and names it in the listing", async () => {
    const cursor = sig(77);
    plan.resume = { [AR]: { signature: cursor, slot: 3_000 }, [TH]: null };
    lists[AR] = [[{ ...row(77, 3_000) }], [row(78, 2_999), row(79, 998)]];
    await runIndexerHeartbeat(deadline());
    expect(pagesAsked().filter((p) => p.account === AR)).toEqual([
      { account: AR, commitment: "confirmed", limit: 100, minContextSlot: BigInt(4_925), before: cursor },
    ]);
    expect((confirms()[0].p_listings as { before: string | null }[]).map((l) => l.before)).toEqual([cursor, null]);
  });

  it("without a floor asks one page only (nothing can be proven)", async () => {
    plan.floors = { [AR]: null, [TH]: null };
    lists[AR] = [Array.from({ length: 20 }, (_, i) => row(i, 3_000 - i)), [row(50, 10)]];
    await runIndexerHeartbeat(deadline());
    expect(pagesAsked().filter((p) => p.account === AR)).toHaveLength(1);
    expect(mocks.multiple.mock.calls[0][1]).toEqual({ encoding: "base64", commitment: "finalized" });
  });

  it.each([
    ["a slot that goes up", [row(1, 900), row(2, 950)]],
    ["a duplicate signature", [row(1, 1_100), row(1, 1_000)]],
    ["a row without err", [{ ...row(1, 900), err: undefined }]],
    ["a malformed signature", [{ ...row(1, 900), signature: "not-a-signature" }]],
    ["a negative slot", [{ ...row(1, 900), slot: BigInt(-1) }]],
    ["an unsafe slot", [{ ...row(1, 900), slot: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(2) }]],
  ])("a listing with %s is not evidence: RPC_ERROR, recorded without a listing", async (_label, page) => {
    lists[AR] = [page as SigRow[]];
    expect(await runIndexerHeartbeat(deadline())).toEqual({ status: "declined", reason: "RPC_ERROR" });
    expect(confirms()).toEqual([{ p_network: "devnet", p_plan_id: PLAN_ID, p_client_reason: "RPC_ERROR",
      p_tip_slot: null, p_listings: null, p_sample: null, p_exempt: null }]);
  });
});

describe("the account sample", () => {
  it("reads only the program account (for the finalized slot) when nothing is planned; a closed account is sent as null", async () => {
    plan.sample = [];
    await runIndexerHeartbeat(deadline());
    expect(mocks.multiple.mock.calls[0][0]).toEqual([AR]);
    expect(confirms()[0].p_sample).toEqual({ context_slot: 4_960, accounts: [] });
    plan.sample = [PDA];
    mocks.multiple.mockResolvedValue({ context: { slot: BigInt(4_961) }, value: [null] });
    await runIndexerHeartbeat(deadline());
    expect(confirms().at(-1)!.p_sample).toEqual({ context_slot: 4_961, accounts: [{ pda: PDA, owner: null, data: null }] });
  });

  it.each([
    ["a short answer", { context: { slot: BigInt(1) }, value: [] }],
    ["no context", { value: [null] }],
    ["an account without owner", { context: { slot: BigInt(1) }, value: [{ data: ["AA==", "base64"] }] }],
    ["another encoding", { context: { slot: BigInt(1) }, value: [{ owner: AR, data: ["AA==", "base58"] }] }],
    ["data that is not base64", { context: { slot: BigInt(1) }, value: [{ owner: AR, data: ["%%%", "base64"] }] }],
  ])("%s is RPC_ERROR", async (_label, answer) => {
    mocks.multiple.mockResolvedValue(answer);
    expect(await runIndexerHeartbeat(deadline())).toEqual({ status: "declined", reason: "RPC_ERROR" });
  });
});

describe("probes (a listed signature that is not in the index)", () => {
  it("exempts only a finalized transaction of that signature that invokes no watched program; a failed probe exempts nothing", async () => {
    const [readOnly, invoking, missing, broken] = [sig(40), sig(41), sig(42), sig(43)];
    const tx = (signature: string, program: string, accounts: string[]) =>
      buildTx({ signature, instructions: [{ ix: { program, accounts, data: new Uint8Array([1]) } }] }).tx;
    mocks.tx.mockImplementation(async (s: string) => {
      if (s === readOnly) return tx(readOnly, PDA, [AR]);              // lists the program ID, runs another program
      if (s === invoking) return tx(invoking, AR, [PDA]);
      if (s === broken) throw new Error("https://rpc.invalid/?api-key=secret");
      return null;
    });
    plan.probe = [readOnly, invoking];
    await runIndexerHeartbeat(deadline());
    expect(confirms()[0].p_exempt).toEqual([readOnly]);
    expect(mocks.tx.mock.calls.map((c) => c[1])).toEqual([
      { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 },
      { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 },
    ]);
    plan.probe = [missing, broken];
    expect(await runIndexerHeartbeat(deadline())).toEqual({ status: "bumped" });
    expect(confirms().at(-1)!.p_exempt).toEqual([]);
    // A transaction answered under another signature is not evidence for this one.
    mocks.tx.mockResolvedValue(tx(sig(44), PDA, [AR]));
    plan.probe = [readOnly];
    await runIndexerHeartbeat(deadline());
    expect(confirms().at(-1)!.p_exempt).toEqual([]);
  });
});

describe("failing closed", () => {
  it("an RPC error records RPC_ERROR, never a partial listing, and never logs the error (it can carry the key)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.sigs.mockRejectedValue(new Error("fetch failed https://devnet.helius-rpc.com/?api-key=secret-key"));
    const result = await runIndexerHeartbeat(deadline());
    expect(result).toEqual({ status: "declined", reason: "RPC_ERROR" });
    expect(confirms()).toHaveLength(1);
    expect(confirms()[0]).toMatchObject({ p_client_reason: "RPC_ERROR", p_listings: null, p_sample: null });
    expect(log.mock.calls).toEqual([["[indexer-heartbeat] declined RPC_ERROR"]]);
    expect(JSON.stringify([result, log.mock.calls, mocks.db.mock.calls])).not.toContain("api-key");
  });

  it("a genesis mismatch or a mainnet deployment without a provider (the RPC throws) is RPC_ERROR", async () => {
    mocks.slot.mockRejectedValue(new Error("The RPC is connected to a different network. Expected devnet"));
    expect(await runIndexerHeartbeat(deadline())).toEqual({ status: "declined", reason: "RPC_ERROR" });
    expect(mocks.sigs).not.toHaveBeenCalled();
  });

  it("a timeout (a call's own, or the stage signal) records RPC_TIMEOUT", async () => {
    mocks.sigs.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));
    expect(await runIndexerHeartbeat(deadline())).toEqual({ status: "declined", reason: "RPC_TIMEOUT" });
    expect(confirms()[0]).toMatchObject({ p_client_reason: "RPC_TIMEOUT" });
    const stage = new AbortController();
    mocks.sigs.mockImplementation((_a: string, _c: unknown, opts: { abortSignal: AbortSignal }) => new Promise((_resolve, reject) => {
      opts.abortSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      setTimeout(() => stage.abort(), 5);
    }));
    expect(await runIndexerHeartbeat(deadline(), stage.signal)).toEqual({ status: "declined", reason: "RPC_TIMEOUT" });
  });

  it("less than the minimum budget: NO_BUDGET without a DB or RPC call", async () => {
    expect(await runIndexerHeartbeat(deadline(HEARTBEAT.minBudgetMs - 100))).toEqual({ status: "declined", reason: "NO_BUDGET" });
    const aborted = new AbortController(); aborted.abort();
    expect(await runIndexerHeartbeat(deadline(), aborted.signal)).toEqual({ status: "declined", reason: "NO_BUDGET" });
    expect(mocks.db).not.toHaveBeenCalled();
    expect(mocks.slot).not.toHaveBeenCalled();
  });

  it("a plan that leaves no RPC phase records NO_BUDGET under that plan", async () => {
    let now = 1_000_000; vi.spyOn(Date, "now").mockImplementation(() => now);
    mocks.db.mockImplementation(async (name: string) => {
      if (name === "indexer_heartbeat_plan") { now += 3_000; return { data: plan, error: null }; }
      return { data: { outcome: "declined", reason: "NO_BUDGET", expired: false }, error: null };
    });
    expect(await runIndexerHeartbeat(1_000_000 + HEARTBEAT.minBudgetMs + 500)).toEqual({ status: "declined", reason: "NO_BUDGET" });
    expect(confirms()).toEqual([expect.objectContaining({ p_plan_id: PLAN_ID, p_client_reason: "NO_BUDGET", p_listings: null })]);
    expect(mocks.slot).not.toHaveBeenCalled();
  });

  it("off, not due, a plan error or a malformed plan: no RPC call", async () => {
    plan = { mode: "off", due: false };
    expect(await runIndexerHeartbeat(deadline())).toEqual({ status: "skipped", reason: "OFF" });
    plan = { mode: "observe", due: false };
    expect(await runIndexerHeartbeat(deadline())).toEqual({ status: "skipped", reason: "NOT_DUE" });
    mocks.db.mockResolvedValueOnce({ data: null, error: { code: "PGRST202" } });
    expect(await runIndexerHeartbeat(deadline())).toEqual({ status: "declined", reason: "DB_ERROR" });
    mocks.db.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await runIndexerHeartbeat(deadline())).toEqual({ status: "declined", reason: "DB_ERROR" });
    expect(mocks.slot).not.toHaveBeenCalled();
    expect(dbCalls().every((c) => c.name === "indexer_heartbeat_plan")).toBe(true);
  });

  it("parsePlan accepts only a whole plan", () => {
    expect(parsePlan(plan)).toMatchObject({ mode: "on", due: true, planId: PLAN_ID, floors: { [AR]: 1_000, [TH]: 1_000 } });
    for (const bad of [
      null, [], { mode: "sometimes" }, { ...plan, plan_id: "x" }, { ...plan, due: "yes" },
      { ...plan, floors: { [AR]: 1 } }, { ...plan, floors: { [AR]: -1, [TH]: 1 } }, { ...plan, floors: { [AR]: 1.5, [TH]: 1 } },
      { ...plan, resume: { [AR]: { signature: "x", slot: 1 }, [TH]: null } }, { ...plan, resume: { [AR]: null } },
      { ...plan, sample: ["not an address"] }, { ...plan, sample: Array(101).fill(PDA) },
      { ...plan, probe: [sig(1), sig(2), sig(3)] }, { ...plan, probe: ["x"] },
    ]) expect(parsePlan(bad), JSON.stringify(bad)).toBeNull();
  });

  it("never throws, whatever fails", async () => {
    mocks.admin.mockImplementation(() => { throw new Error("SUPABASE_SERVICE_ROLE_KEY missing"); });
    expect(await runIndexerHeartbeat(deadline())).toEqual({ status: "declined", reason: "INTERNAL_ERROR" });
    mocks.admin.mockImplementation(() => ({ rpc: () => { throw new Error("boom"); } }));
    expect(await runIndexerHeartbeat(deadline())).toEqual({ status: "declined", reason: "DB_ERROR" });
    mocks.admin.mockImplementation(() => ({
      rpc: (name: string, args: unknown) => ({ abortSignal: (signal: AbortSignal) => mocks.db(name, args, signal) }),
    }));
    for (const m of [mocks.slot, mocks.sigs, mocks.multiple, mocks.tx]) m.mockRejectedValue(new Error("down"));
    mocks.db.mockImplementation(async (name: string) => {
      if (name === "indexer_heartbeat_plan") return { data: plan, error: null };
      throw new Error("down");
    });
    expect(await runIndexerHeartbeat(deadline())).toEqual({ status: "declined", reason: "RPC_ERROR" });
  });
});

describe("the program IDs", () => {
  it("are the same in the heartbeat, 0075, 0047's enqueue and the webhook receiver", () => {
    expect([...HEARTBEAT_PROGRAMS]).toEqual(["FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS", "GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy"]);
    const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
    const heartbeatSql = read("supabase/migrations/0075_indexer_heartbeat.sql");
    const body = heartbeatSql.match(/function public\.indexer_heartbeat_programs\(\)[\s\S]*?array\[([^\]]*)\]/);
    expect(body?.[1].match(/'([1-9A-HJ-NP-Za-km-z]{32,44})'/g)?.map((s) => s.slice(1, -1))).toEqual([...HEARTBEAT_PROGRAMS]);
    const enqueue = read("supabase/migrations/0047_indexer_retry.sql").match(/insert into public\.indexer_events\([^)]*\)\s*values\(p_network,p_signature,p_slot,p_block_time,'([^']+)'/);
    expect(enqueue?.[1]).toBe(HEARTBEAT_PROGRAMS[0]);
    const webhook = read("supabase/functions/_shared/indexer-webhook.ts").match(/const PROGRAMS = new Set\(\[([^\]]*)\]\)/);
    expect(new Set(webhook?.[1].match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)))).toEqual(new Set(HEARTBEAT_PROGRAMS));
  });
});
