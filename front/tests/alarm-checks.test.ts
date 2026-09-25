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
  hang: false,
}));
vi.mock("@/lib/network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/network")>()),
  detectNetwork: () => "devnet",
}));
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => ({}) }));
vi.mock("@/lib/server/maintenance", () => ({ readMaintenance: async () => ({ enabled: false, fresh: true }) }));
vi.mock("@/lib/server/sale-capacity-chain", () => ({
  listFinalizedSignatures: vi.fn(async (account: string, _from: number, _to: number, signal: AbortSignal, pages: number) => {
    state.pagesAsked.push(pages);
    if (state.hang) {
      // A slow RPC: answers only when the caller gives up.
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }
    return { signatures: state.lists[account] ?? [], complete: state.complete };
  }),
  finalizedTransaction: vi.fn(async (sig: string) => state.txs[sig] ?? null),
}));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => { throw new Error("not in tests"); } }));

import { ASSET_REGISTRY_PROGRAM_ADDRESS } from "@/lib/generated/asset_registry";
import { TRANSFER_HOOK_PROGRAM_ADDRESS, findBlocklistAuthorityPda } from "@/lib/generated/transfer_hook";
import {
  GAP_SCAN_OVERDUE_MS, GAP_SCAN_RESERVE_MS, gapScan, gapScanOverdueState, invokesWatchedProgram, runAlarmChecks, thresholdState,
} from "@/lib/server/alarm-checks";
import { LOADER_V4, programDataAddresses } from "@/lib/server/onchain-alarms";
import { buildTx } from "./helpers/chain-tx";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

type Rpc = { fn: string; args: Record<string, unknown> };
// broken: a table name, or "table.columns" for one select only; slow: ms a table's reads take;
// codes: the error code a broken key answers with (default 08006, a connection failure).
function mockSb(
  tables: Record<string, Record<string, unknown>[]>, broken: string[] = [], slow: Record<string, number> = {},
  codes: Record<string, string> = {},
) {
  const rpcs: Rpc[] = [];
  const sb = {
    from: (table: string) => {
      const rows = tables[table] ?? [];
      const b: Record<string, unknown> = {};
      let counted = false;
      let cols = "";
      b.select = (c: string, opts?: { count?: string }) => { cols = c; counted = !!opts?.count; return b; };
      for (const m of ["eq", "in", "lte", "gte", "order", "limit", "is", "not", "like", "neq"]) b[m] = () => b;
      const isBroken = () => broken.includes(table) || broken.includes(`${table}.${cols}`);
      const errorCode = () => codes[table] ?? "08006";
      const later = <T>(v: () => T) => slow[table]
        ? new Promise<T>((resolve) => setTimeout(() => resolve(v()), slow[table]))
        : Promise.resolve(v());
      const result = () => isBroken()
        ? { data: null, error: { code: errorCode() } }
        : { data: rows, error: null, ...(counted ? { count: rows.length } : {}) };
      const single = () => later(() => isBroken() ? { data: null, error: { code: errorCode() } } : { data: rows[0] ?? null, error: null });
      b.maybeSingle = () => ({ abortSignal: single });
      b.abortSignal = () => Object.assign(later(result), { maybeSingle: single });
      b.then = (resolve: (v: unknown) => unknown) => later(result).then(resolve);
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
  state.hang = false;
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
  it("pages the five watched addresses, re-queues missing transactions through the indexer, and reports an incomplete window", async () => {
    const missing = "4".repeat(88);
    const known = "5".repeat(88);
    state.lists[ASSET_REGISTRY_PROGRAM_ADDRESS] = [{ signature: missing, blockTime: 1_700_000_000 }, { signature: known, blockTime: 1_700_000_001 }];
    state.complete = false;
    state.txs[missing] = buildTx({ signature: missing, instructions: [{ ix: { program: ASSET_REGISTRY_PROGRAM_ADDRESS, accounts: [MINT], data: new Uint8Array([1]) } }] }).tx;
    const { sb, rpcs } = mockSb({ indexer_events: [{ signature: known }] });
    const result = await gapScan(sb, "devnet", Date.now(), AbortSignal.timeout(5_000));
    expect(result).toEqual({ missing: 1, repaired: 1, ignored: 0, complete: false });
    expect(state.pagesAsked).toEqual([5, 5, 5, 5, 5]);
    expect(rpcs).toHaveLength(1);
    expect(rpcs[0]).toMatchObject({ fn: "enqueue_indexer_events", args: { p_network: "devnet" } });
    const [event] = rpcs[0].args.p_events as Record<string, unknown>[];
    expect(event).toMatchObject({ signature: missing, ix_name: "GAP_SCAN", payload: { source: "gap-scan" } });
    expect(event.wallets).toEqual(expect.arrayContaining([MINT, ASSET_REGISTRY_PROGRAM_ADDRESS]));
  });

  it("ignores a listed transaction that invokes none of the watched programs (a read-only listing of the blocklist PDA)", async () => {
    const [blocklistAuthority] = await findBlocklistAuthorityPda();
    const junk = "6".repeat(88);
    const hookAdmin = "7".repeat(88);
    state.lists[blocklistAuthority] = [{ signature: junk, blockTime: 1_700_000_000 }, { signature: hookAdmin, blockTime: 1_700_000_001 }];
    // Anyone can list the PDA read-only in a transaction of their own program.
    state.txs[junk] = buildTx({ signature: junk, instructions: [{ ix: { program: MINT, accounts: [blocklistAuthority], data: new Uint8Array([9]) } }] }).tx;
    state.txs[hookAdmin] = buildTx({ signature: hookAdmin, instructions: [{ ix: { program: TRANSFER_HOOK_PROGRAM_ADDRESS, accounts: [MINT, blocklistAuthority], data: new Uint8Array([1]) } }] }).tx;
    const { sb, rpcs } = mockSb({ indexer_events: [] });
    const result = await gapScan(sb, "devnet", Date.now(), AbortSignal.timeout(5_000));
    expect(result).toEqual({ missing: 1, repaired: 1, ignored: 1, complete: true });
    expect(rpcs.map((r) => (r.args.p_events as { signature: string }[])[0].signature)).toEqual([hookAdmin]);
  });

  it("lists the transfer_hook program ID too: a missed hook-only transaction is re-queued (0075 requires it indexed)", async () => {
    const hookOnly = "3".repeat(88);
    const readOnly = "9".repeat(88);
    state.lists[TRANSFER_HOOK_PROGRAM_ADDRESS] = [{ signature: hookOnly, blockTime: 1_700_000_000 }, { signature: readOnly, blockTime: 1_700_000_001 }];
    state.txs[hookOnly] = buildTx({ signature: hookOnly, instructions: [{ ix: { program: TRANSFER_HOOK_PROGRAM_ADDRESS, accounts: [MINT], data: new Uint8Array([2]) } }] }).tx;
    // Lists the hook program ID as a read-only account of another program: never delivered, ignored.
    state.txs[readOnly] = buildTx({ signature: readOnly, instructions: [{ ix: { program: MINT, accounts: [TRANSFER_HOOK_PROGRAM_ADDRESS], data: new Uint8Array([2]) } }] }).tx;
    const { sb, rpcs } = mockSb({ indexer_events: [] });
    const result = await gapScan(sb, "devnet", Date.now(), AbortSignal.timeout(5_000));
    expect(result).toEqual({ missing: 1, repaired: 1, ignored: 1, complete: true });
    expect(rpcs.map((r) => (r.args.p_events as { signature: string }[])[0].signature)).toEqual([hookOnly]);
  });

  it("watched programs: our two programs, the upgradeable loader on our ProgramData, loader v4 on our programs", async () => {
    const pd = await programDataAddresses();
    const tx = (program: string, accounts: string[]) =>
      buildTx({ signature: "8".repeat(88), instructions: [{ ix: { program, accounts, data: new Uint8Array([0, 0, 0, 0]) } }] }).tx;
    expect(invokesWatchedProgram(tx(ASSET_REGISTRY_PROGRAM_ADDRESS, [MINT]), pd)).toBe(true);
    expect(invokesWatchedProgram(tx("BPFLoaderUpgradeab1e11111111111111111111111", [pd.transferHook]), pd)).toBe(true);
    expect(invokesWatchedProgram(tx("BPFLoaderUpgradeab1e11111111111111111111111", [MINT]), pd)).toBe(false);
    expect(invokesWatchedProgram(tx(LOADER_V4, [ASSET_REGISTRY_PROGRAM_ADDRESS]), pd)).toBe(true);
    expect(invokesWatchedProgram(tx(MINT, [ASSET_REGISTRY_PROGRAM_ADDRESS]), pd)).toBe(false);
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
    expect(reported(rpcs)).toMatchObject({ "indexer-gap": "pass/high", "gap-scan-incomplete": "fail/medium", "gap-scan-overdue": "pass/high" });
    expect(result.reports.length).toBe(result.expected);
  });

  it("gap-scan-overdue: pass when a scan ran or none is due, hold while one is due, fail after 15 minutes without one", () => {
    const now = Date.now();
    const ago = (m: number) => now - m * 60_000;
    expect(gapScanOverdueState(ago(60), true, now)).toBe("pass");
    expect(gapScanOverdueState(ago(3), false, now)).toBe("pass");
    expect(gapScanOverdueState(ago(6), false, now)).toBe("hold");
    expect(gapScanOverdueState(now - GAP_SCAN_OVERDUE_MS + 1, false, now)).toBe("hold");
    expect(gapScanOverdueState(now - GAP_SCAN_OVERDUE_MS, false, now)).toBe("fail");
    // Never scanned: the first run that has time decides (no bootstrap alert).
    expect(gapScanOverdueState(null, false, now)).toBe("hold");
  });

  it("a due scan that the cheap checks leave no time for is expected (a partial stage) and reported, never silent", async () => {
    // The cheap checks take 400 ms and the gap sub-deadline is 200 ms away.
    const { sb, rpcs } = mockSb(
      { worker_heartbeats: [{ last_ok_at: minutesAgo(1), last_gap_scan_at: minutesAgo(6) }] }, [], { indexer_sync_state: 400 });
    const deadline = Date.now() + GAP_SCAN_RESERVE_MS + 200;
    const result = await runAlarmChecks(sb, deadline, AbortSignal.timeout(GAP_SCAN_RESERVE_MS + 200));
    expect(result.gapScan).toBeNull();
    expect(state.pagesAsked).toEqual([]);
    // Every cheap incident and gap-scan-overdue were recorded; the skipped scan is the one miss.
    expect(Object.keys(reported(rpcs))).toEqual(expect.arrayContaining(
      ["indexer-queue", "event-queue", "ledger-queue", "indexer-degraded", "event-invalid", "worker-retry", "capacity-holds"]));
    expect(reported(rpcs)["gap-scan-overdue"]).toBe("hold/high");
    expect(reported(rpcs)["gap-scan-incomplete"]).toBeUndefined();
    expect(result.expected).toBe(result.reports.length + 1);
    expect(Date.now()).toBeLessThan(deadline);
  });

  it("a scan skipped for 15 minutes fails gap-scan-overdue", async () => {
    const { sb, rpcs } = mockSb(
      { worker_heartbeats: [{ last_ok_at: minutesAgo(1), last_gap_scan_at: minutesAgo(16) }] }, [], { indexer_sync_state: 400 });
    const result = await runAlarmChecks(sb, Date.now() + GAP_SCAN_RESERVE_MS + 200, AbortSignal.timeout(GAP_SCAN_RESERVE_MS + 200));
    expect(result.gapScan).toBeNull();
    expect(reported(rpcs)["gap-scan-overdue"]).toBe("fail/high");
    const overdue = rpcs.find((r) => r.args.p_check === "gap-scan-overdue");
    expect(overdue?.args).toMatchObject({ p_source: "indexer:gap-scan-overdue", p_evidence: { minutes_since_last_scan: 16, ran_now: false } });
    expect(result.expected).toBe(result.reports.length + 1);
  });

  it("an unreadable due state is a check that could not run: no scan, no overdue report, the stage is partial", async () => {
    const { sb, rpcs } = mockSb(
      { worker_heartbeats: [{ last_ok_at: minutesAgo(1), last_gap_scan_at: minutesAgo(30) }] }, ["worker_heartbeats.last_gap_scan_at"]);
    const result = await runAlarmChecks(sb, Date.now() + 10_000, AbortSignal.timeout(10_000));
    expect(result.gapScan).toBeNull();
    expect(state.pagesAsked).toEqual([]);
    expect(reported(rpcs)["worker-retry"]).toBe("pass/high");
    expect(reported(rpcs)["gap-scan-overdue"]).toBeUndefined();
    expect(result.expected).toBe(result.reports.length + 1);
  });

  it("an unparseable stamp counts as never scanned: the scan is due and runs", async () => {
    const { sb, rpcs } = mockSb({ worker_heartbeats: [{ last_ok_at: minutesAgo(1), last_gap_scan_at: "not-a-date" }] });
    const result = await runAlarmChecks(sb, Date.now() + 10_000, AbortSignal.timeout(10_000));
    expect(result.gapScan).toMatchObject({ ran: true, cutShort: false });
    expect(reported(rpcs)["gap-scan-overdue"]).toBe("pass/high");
    expect(result.reports.length).toBe(result.expected);
  });

  it("records the cheap incidents BEFORE the gap scan; a scan that overruns its sub-deadline is cut short, stamped and reported", async () => {
    state.hang = true;
    const { sb, rpcs } = mockSb({ worker_heartbeats: [{ last_ok_at: minutesAgo(1), last_gap_scan_at: minutesAgo(6) }] });
    const deadline = Date.now() + GAP_SCAN_RESERVE_MS + 300;
    const result = await runAlarmChecks(sb, deadline, AbortSignal.timeout(GAP_SCAN_RESERVE_MS + 300));
    const checks = rpcs.filter((r) => r.fn === "report_incident").map((r) => r.args.p_check);
    // Every cheap check was recorded first, then the scan's own incident.
    expect(checks.slice(0, 5)).toEqual(["indexer-queue", "event-queue", "ledger-queue", "indexer-degraded", "event-invalid"]);
    expect(checks.at(-1)).toBe("gap-scan-incomplete");
    expect(reported(rpcs)["gap-scan-incomplete"]).toBe("fail/medium");
    expect(reported(rpcs)["indexer-gap"]).toBeUndefined();
    expect(result.gapScan).toMatchObject({ ran: true, cutShort: true, complete: false });
    expect(result.reports.length).toBe(result.expected);
    expect(Date.now()).toBeLessThan(deadline);
  });

  it("a check that cannot run is expected but not recorded (the worker then counts the stage as failed)", async () => {
    const { sb } = mockSb({ worker_heartbeats: [{ last_ok_at: minutesAgo(1), last_gap_scan_at: minutesAgo(1) }] }, ["indexer_sync_state.status"]);
    const result = await runAlarmChecks(sb, Date.now() + 10_000, AbortSignal.timeout(10_000));
    expect(result.expected).toBe(result.reports.length + 1);
    expect(result.reports.map((r) => r.check)).not.toContain("indexer-degraded");
  });

  it("past the deadline nothing runs and everything is expected", async () => {
    const { sb, rpcs } = mockSb({});
    const result = await runAlarmChecks(sb, Date.now() - 1, AbortSignal.timeout(10_000));
    expect(rpcs).toEqual([]);
    expect(result).toMatchObject({ reports: [], gapScan: null });
    expect(result.expected).toBeGreaterThan(0);
  });
});

describe("indexer-freshness (0075)", () => {
  const run = async (tables: Record<string, Record<string, unknown>[]>, broken: string[] = [], codes: Record<string, string> = {}) => {
    const { sb, rpcs } = mockSb({ worker_heartbeats: [{ last_ok_at: minutesAgo(1), last_gap_scan_at: minutesAgo(1) }], ...tables }, broken, {}, codes);
    const result = await runAlarmChecks(sb, Date.now() + 10_000, AbortSignal.timeout(10_000));
    const report = rpcs.find((r) => r.fn === "report_incident" && r.args.p_check === "indexer-freshness");
    return { result, report, state: report ? `${report.args.p_state}/${report.args.p_severity}` : undefined };
  };
  const ready = (checkedMinutesAgo: number) => [{ status: "ready", checked_at: minutesAgo(checkedMinutesAgo), completed_at: minutesAgo(600) }];
  const hb = (mode: string, provenMinutesAgo: number | null, reason: string | null = null) => [{
    mode, last_attempt_at: minutesAgo(1), last_proven_at: provenMinutesAgo === null ? null : minutesAgo(provenMinutesAgo), last_reason: reason,
  }];

  it("passes under 3 minutes, holds between, fails at 15 minutes without a proof; low in observe, medium in on", async () => {
    expect((await run({ indexer_sync_state: ready(20), indexer_heartbeat_state: hb("on", 1) })).state).toBe("pass/medium");
    expect((await run({ indexer_sync_state: ready(20), indexer_heartbeat_state: hb("on", 5) })).state).toBe("hold/medium");
    const failed = await run({ indexer_sync_state: ready(20), indexer_heartbeat_state: hb("on", 16, "UNINDEXED_SIGNATURE") });
    expect(failed.state).toBe("fail/medium");
    expect(failed.report?.args).toMatchObject({ p_source: "indexer:freshness", p_category: "indexer",
      p_evidence: { mode: "on", reason: "UNINDEXED_SIGNATURE", minutes_since_proof: 16 } });
    expect((await run({ indexer_sync_state: ready(20), indexer_heartbeat_state: hb("observe", 16) })).state).toBe("fail/low");
    expect((await run({ indexer_sync_state: ready(20), indexer_heartbeat_state: hb("observe", null) })).state).toBe("fail/low");
  });

  it("passes while jobs keep the mirror fresh although the heartbeat declines (busy network, PENDING_JOBS)", async () => {
    const { state, result } = await run({ indexer_sync_state: ready(0.5), indexer_heartbeat_state: hb("on", 40, "PENDING_JOBS") });
    expect(state).toBe("pass/medium");
    expect(result.reports.length).toBe(result.expected);
  });

  it("passes when off; holds when it never ran or the indexer is not ready (indexer-degraded owns that)", async () => {
    expect((await run({ indexer_sync_state: ready(60), indexer_heartbeat_state: hb("off", null) })).state).toBe("pass/low");
    expect((await run({ indexer_sync_state: ready(60), indexer_heartbeat_state: [] })).state).toBe("hold/low");
    expect((await run({ indexer_sync_state: ready(60), indexer_heartbeat_state: [{ mode: "on", last_attempt_at: null }] })).state).toBe("hold/medium");
    expect((await run({ indexer_sync_state: [{ status: "degraded", checked_at: minutesAgo(60), completed_at: minutesAgo(600) }],
      indexer_heartbeat_state: hb("on", 60) })).state).toBe("hold/medium");
  });

  it("reports nothing before 0075 is applied (a missing table is not a failed check); a read error is a check that could not run", async () => {
    const missing = await run({ indexer_sync_state: ready(1) }, ["indexer_heartbeat_state"], { indexer_heartbeat_state: "PGRST205" });
    expect(missing.report).toBeUndefined();
    expect(missing.result.reports.length).toBe(missing.result.expected);
    const down = await run({ indexer_sync_state: ready(1) }, ["indexer_heartbeat_state"]);
    expect(down.report).toBeUndefined();
    expect(down.result.expected).toBe(down.result.reports.length + 1);
  });
});
