// Talas 4.4b: the alarm worker's checks (design §3e/§4.2) and the gap scan.
// The hysteresis itself (report_incident) runs for real in
// onchain-alarms.postgres.test.ts; here Supabase and RPC are mocked.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  lists: {} as Record<string, Array<{ signature: string; blockTime: number }>>,
  complete: true,
  txs: {} as Record<string, unknown>,
  pagesAsked: [] as number[],
}));
vi.mock("@/lib/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/network")>()),
  detectNetwork: () => "devnet",
}));
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => ({}) }));
vi.mock("@/lib/server/maintenance", () => ({ readMaintenance: async () => ({ enabled: false, fresh: true }) }));
vi.mock("@/lib/server/sale-capacity-chain", () => ({
  listFinalizedSignatures: vi.fn(async (account: string, _from: number, _to: number, _signal: unknown, pages: number) => {
    state.pagesAsked.push(pages);
    return { signatures: state.lists[account] ?? [], complete: state.complete };
  }),
  finalizedTransaction: vi.fn(async (sig: string) => state.txs[sig] ?? null),
}));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => { throw new Error("not in tests"); } }));

import { ASSET_REGISTRY_PROGRAM_ADDRESS } from "@/lib/generated/asset_registry";
import { gapScan, runAlarmChecks, thresholdState } from "@/lib/server/alarm-checks";
import { buildTx } from "./helpers/chain-tx";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

type Rpc = { fn: string; args: Record<string, unknown> };
function mockSb(tables: Record<string, Record<string, unknown>[]>) {
  const rpcs: Rpc[] = [];
  const sb = {
    from: (table: string) => {
      const rows = tables[table] ?? [];
      const b: Record<string, unknown> = {};
      let counted = false;
      b.select = (_cols: string, opts?: { count?: string }) => { counted = !!opts?.count; return b; };
      for (const m of ["eq", "in", "lte", "gte", "order", "limit", "is", "not", "like", "neq"]) b[m] = () => b;
      const result = () => ({ data: rows, error: null, ...(counted ? { count: rows.length } : {}) });
      b.maybeSingle = () => ({ abortSignal: () => Promise.resolve({ data: rows[0] ?? null, error: null }) });
      b.abortSignal = () => Object.assign(Promise.resolve(result()), { maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }) });
      b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve);
      return b;
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      return { abortSignal: () => Promise.resolve({ data: { action: "opened", alert_id: null }, error: null }) };
    },
  };
  return { sb: sb as never, rpcs };
}

beforeEach(() => {
  state.lists = {};
  state.complete = true;
  state.txs = {};
  state.pagesAsked = [];
});

describe("thresholds", () => {
  it("fail at the fail threshold, pass below the clear threshold, hold between", () => {
    expect(thresholdState(null, 300, 150)).toBe("pass");
    expect(thresholdState(100, 300, 150)).toBe("pass");
    expect(thresholdState(200, 300, 150)).toBe("hold");
    expect(thresholdState(300, 300, 150)).toBe("fail");
  });
});

describe("gap scan", () => {
  it("pages the four watched addresses, re-queues missing transactions through the indexer, and reports an incomplete window", async () => {
    const missing = "4".repeat(88);
    const known = "5".repeat(88);
    state.lists[ASSET_REGISTRY_PROGRAM_ADDRESS] = [{ signature: missing, blockTime: 1_700_000_000 }, { signature: known, blockTime: 1_700_000_001 }];
    state.complete = false;
    state.txs[missing] = buildTx({ signature: missing, instructions: [{ ix: { program: ASSET_REGISTRY_PROGRAM_ADDRESS, accounts: [MINT], data: new Uint8Array([1]) } }] }).tx;
    const { sb, rpcs } = mockSb({ indexer_events: [{ signature: known }] });
    const result = await gapScan(sb, "devnet", Date.now(), AbortSignal.timeout(5_000));
    expect(result).toEqual({ missing: 1, repaired: 1, complete: false });
    expect(state.pagesAsked).toEqual([5, 5, 5, 5]);
    expect(rpcs).toHaveLength(1);
    expect(rpcs[0]).toMatchObject({ fn: "enqueue_indexer_events", args: { p_network: "devnet" } });
    const [event] = rpcs[0].args.p_events as Record<string, unknown>[];
    expect(event).toMatchObject({ signature: missing, ix_name: "GAP_SCAN", payload: { source: "gap-scan" } });
    expect(event.wallets).toEqual(expect.arrayContaining([MINT, ASSET_REGISTRY_PROGRAM_ADDRESS]));
  });
});

describe("runAlarmChecks", () => {
  const reported = (rpcs: Rpc[]) => Object.fromEntries(rpcs.filter((r) => r.fn === "report_incident")
    .map((r) => [r.args.p_check, `${r.args.p_state}/${r.args.p_severity}`]));

  it("reports every check with its hysteresis state; a stale rate behind a revaluation hold is high", async () => {
    const { sb, rpcs } = mockSb({
      indexer_jobs: [{ created_at: minutesAgo(40) }],
      onchain_event_jobs: [{ created_at: minutesAgo(1), last_error: "NOT_FINALIZED" }],
      spv_issuance_jobs: [],
      indexer_sync_state: [{ status: "ready" }],
      worker_heartbeats: [{ last_ok_at: minutesAgo(20), last_gap_scan_at: minutesAgo(1) }],
      sale_capacity_holds: [{ subject: "spv:x", ref: "r", code: "FX_REVALUE", payment_mint: MINT, created_at: minutesAgo(45) }],
      fx_rates: [{ payment_mint: MINT, kind: "rate", as_of: minutesAgo(8 * 24 * 60), max_age: "7 days" }],
      sale_capacity_reservations: [],
      sales: [],
      alarm_incidents: [],
    });
    const result = await runAlarmChecks(sb, Date.now() + 10_000, AbortSignal.timeout(10_000));
    expect(reported(rpcs)).toMatchObject({
      "indexer-queue": "fail/high",
      "event-queue": "pass/medium",
      "ledger-queue": "pass/high",
      "indexer-degraded": "pass/medium",
      // The mock returns the same rows for "invalid in the last 24 h".
      "event-invalid": "fail/medium",
      "worker-retry": "fail/high",
      [`fx-stale:${MINT}`]: "fail/high",
      "capacity-holds": "fail/high",
    });
    // The gap scan ran a minute ago: not due.
    expect(result.gapScan).toBeNull();
    expect(rpcs.every((r) => r.fn === "report_incident")).toBe(true);
  });

  it("a recovered FX incident whose mint is no longer held or in use reports pass", async () => {
    const { sb, rpcs } = mockSb({
      worker_heartbeats: [{ last_ok_at: minutesAgo(1), last_gap_scan_at: minutesAgo(1) }],
      alarm_incidents: [{ check_key: `fx-missing:${MINT}` }],
      fx_rates: [{ payment_mint: MINT, kind: "rate", as_of: minutesAgo(1), max_age: "7 days" }],
    });
    await runAlarmChecks(sb, Date.now() + 10_000, AbortSignal.timeout(10_000));
    expect(reported(rpcs)[`fx-missing:${MINT}`]).toBe("pass/high");
    expect(reported(rpcs)["capacity-holds"]).toBe("pass/high");
  });

  it("runs the gap scan when due and reports indexer-gap and gap-scan-incomplete", async () => {
    state.complete = false;
    const { sb, rpcs } = mockSb({ worker_heartbeats: [{ last_ok_at: minutesAgo(1), last_gap_scan_at: minutesAgo(6) }] });
    const result = await runAlarmChecks(sb, Date.now() + 10_000, AbortSignal.timeout(10_000));
    expect(result.gapScan).toMatchObject({ ran: true, missing: 0, complete: false });
    expect(reported(rpcs)).toMatchObject({ "indexer-gap": "pass/high", "gap-scan-incomplete": "fail/medium" });
  });
});
