// Talas 4.4b: the alarm worker's checks (design §3e/§4.2) and the gap scan.
// The hysteresis itself (report_incident) runs for real in
// onchain-alarms.postgres.test.ts; here Supabase and RPC are mocked.
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  lists: {} as Record<string, Array<{ signature: string; blockTime: number }>>,
  complete: true,
  /** Accounts whose listing runs out of pages although `complete` is true. */
  incomplete: [] as string[],
  txs: {} as Record<string, unknown>,
  pagesAsked: [] as number[],
  hang: false,
  /** The operational watches' chain reads hang (a degraded RPC). */
  opsHang: false,
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
    return { signatures: state.lists[account] ?? [], complete: state.complete && !state.incomplete.includes(account) };
  }),
  finalizedTransaction: vi.fn(async (sig: string) => state.txs[sig] ?? null),
}));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => { throw new Error("not in tests"); } }));
vi.mock("@/lib/server/ops-watch", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/server/ops-watch")>();
  return {
    ...real,
    opsWatchReports: vi.fn((...args: Parameters<typeof real.opsWatchReports>) => state.opsHang
      ? new Promise<never>((_resolve, reject) => args[2].addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
      : real.opsWatchReports(...args)),
  };
});

import { ASSET_REGISTRY_PROGRAM_ADDRESS } from "@/lib/generated/asset_registry";
import { TRANSFER_HOOK_PROGRAM_ADDRESS, findBlocklistAuthorityPda } from "@/lib/generated/transfer_hook";
import {
  GAP_SCAN_HOOK_PAGES, GAP_SCAN_OVERDUE_MS, GAP_SCAN_PAGES, GAP_SCAN_RESERVE_MS, gapScan, gapScanOverdueState, invokesWatchedProgram,
  bootstrapOpenReport, fxAutoReports, payoutModulesReport, marketRefusals, primaryIdleReport, roleChangesReport, runAlarmChecks, thresholdState,
} from "@/lib/server/alarm-checks";
import { LOADER_V4, programDataAddresses } from "@/lib/server/onchain-alarms";
import { USDC } from "@/lib/payment-mints";
import { SOURCE_LABELS } from "@/lib/server/system-alerts";
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
  state.incomplete = [];
  state.txs = {};
  state.pagesAsked = [];
  state.hang = false;
  state.opsHang = false;
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
    expect(result).toEqual({ missing: 1, repaired: 1, ignored: 0, complete: false, hookComplete: false });
    // Four addresses on the full budget, then the hook program ID on its own.
    expect(state.pagesAsked).toEqual([5, 5, 5, 5, 2]);
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
    expect(result).toEqual({ missing: 1, repaired: 1, ignored: 1, complete: true, hookComplete: true });
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
    expect(result).toEqual({ missing: 1, repaired: 1, ignored: 1, complete: true, hookComplete: true });
    expect(rpcs.map((r) => (r.args.p_events as { signature: string }[])[0].signature)).toEqual([hookOnly]);
  });

  it("a busy hook (every hooked transfer lists its program ID) runs out of its own pages without making the scan incomplete", async () => {
    state.incomplete = [TRANSFER_HOOK_PROGRAM_ADDRESS];
    const { sb } = mockSb({ indexer_events: [] });
    const result = await gapScan(sb, "devnet", Date.now(), AbortSignal.timeout(5_000));
    expect(result).toMatchObject({ complete: true, hookComplete: false });
    expect(GAP_SCAN_HOOK_PAGES).toBeLessThan(GAP_SCAN_PAGES);
    expect(state.pagesAsked.at(-1)).toBe(GAP_SCAN_HOOK_PAGES);
  });

  it("a fetched transaction without its status meta counts as watched (a CPI could be hidden): missing and re-queued", async () => {
    const noMeta = "2".repeat(88);
    state.lists[TRANSFER_HOOK_PROGRAM_ADDRESS] = [{ signature: noMeta, blockTime: 1_700_000_000 }];
    const t = buildTx({ signature: noMeta, instructions: [{ ix: { program: MINT, accounts: [TRANSFER_HOOK_PROGRAM_ADDRESS], data: new Uint8Array([2]) } }] }).tx;
    state.txs[noMeta] = { ...t, meta: null };
    const { sb, rpcs } = mockSb({ indexer_events: [] });
    expect(await gapScan(sb, "devnet", Date.now(), AbortSignal.timeout(5_000))).toMatchObject({ missing: 1, repaired: 1, ignored: 0 });
    expect(rpcs).toHaveLength(1);
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
    // Without the status meta a CPI cannot be seen: watched (conservative).
    const wrapper = tx(MINT, [ASSET_REGISTRY_PROGRAM_ADDRESS]);
    expect(invokesWatchedProgram({ ...wrapper, meta: null }, pd)).toBe(true);
    expect(invokesWatchedProgram({ ...wrapper, meta: { ...wrapper.meta, innerInstructions: null } }, pd)).toBe(true);
    const lookups = { ...wrapper.transaction, message: { ...wrapper.transaction.message, addressTableLookups: [{ accountKey: MINT }] } };
    expect(invokesWatchedProgram({ ...wrapper, transaction: lookups, meta: { ...wrapper.meta, loadedAddresses: null } }, pd)).toBe(true);
    expect(invokesWatchedProgram({ ...wrapper, transaction: lookups }, pd)).toBe(false);
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

  it("fx-expiring: the default mint and mints in use warn 2 days (at most half the max age) before the max age", async () => {
    // The rows are dated from Date.now() and the checks read it again: frozen,
    // so `hours_left` (floored) cannot drop a unit when a millisecond passes in
    // between. Only Date is faked; timers (AbortSignal.timeout) stay real.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    onTestFinished(() => { vi.useRealTimers(); });
    const usdc = USDC.devnet!.mint;
    const check = async (fx: Record<string, unknown>[], extra: Record<string, Record<string, unknown>[]> = {}) => {
      const { sb, rpcs } = mockSb({ worker_heartbeats: [{ last_ok_at: minutesAgo(1), last_gap_scan_at: minutesAgo(1) }], fx_rates: fx, ...extra });
      const result = await runAlarmChecks(sb, Date.now() + 10_000, AbortSignal.timeout(10_000));
      expect(result.reports.length).toBe(result.expected);
      return { by: reported(rpcs), rpcs };
    };
    const rate = (mint: string, daysAgo: number, maxAge = "7 days") => ({ payment_mint: mint, kind: "rate", as_of: minutesAgo(daysAgo * 24 * 60), max_age: maxAge });
    // Day 5.5 of 7: inside the 2-day window, although no sale uses the mint.
    const { by, rpcs } = await check([rate(usdc, 5.5)]);
    expect(by[`fx-expiring:${usdc}`]).toBe("fail/medium");
    expect(rpcs.find((r) => r.args.p_check === `fx-expiring:${usdc}`)?.args).toMatchObject({ p_source: "fx:expiring", p_category: "fx",
      p_evidence: { payment_mint: usdc, hours_left: 36 } });
    expect((await check([rate(usdc, 4.9)])).by[`fx-expiring:${usdc}`]).toBe("pass/medium");
    // A 1-day max age warns in its last 12 hours only; an eur_peg row never expires.
    expect((await check([rate(usdc, 0.4, "1 day")])).by[`fx-expiring:${usdc}`]).toBe("pass/medium");
    expect((await check([rate(usdc, 0.6, "1 day")])).by[`fx-expiring:${usdc}`]).toBe("fail/medium");
    expect((await check([{ ...rate(usdc, 30), kind: "eur_peg" }])).by[`fx-expiring:${usdc}`]).toBeUndefined();
    // A mint in use (an open sale) is tracked too.
    const inUse = await check([rate(MINT, 6)], { sales: [{ payment_mint: MINT }] });
    expect(inUse.by).toMatchObject({ [`fx-expiring:${MINT}`]: "fail/medium", [`fx-stale:${MINT}`]: "pass/medium" });
    // Past the max age it is fx-stale's alone (one condition, one alert); an old
    // rate of the default mint no sale uses does not open a lasting alert either.
    const expired = await check([rate(MINT, 8)], { sales: [{ payment_mint: MINT }] });
    expect(expired.by).toMatchObject({ [`fx-expiring:${MINT}`]: "pass/medium", [`fx-stale:${MINT}`]: "fail/medium" });
    expect((await check([rate(usdc, 90)])).by[`fx-expiring:${usdc}`]).toBe("pass/medium");
    // An open incident of a mint neither in use nor the default clears.
    const gone = await check([rate(MINT, 6)], { alarm_incidents: [{ check_key: `fx-expiring:${MINT}` }] });
    expect(gone.by[`fx-expiring:${MINT}`]).toBe("pass/medium");
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

  it("a hanging chain read of the operational watches costs neither the cheap incidents nor the gap scan", async () => {
    state.opsHang = true;
    const { sb, rpcs } = mockSb({ worker_heartbeats: [{ last_ok_at: minutesAgo(1), last_gap_scan_at: minutesAgo(6) }] });
    const started = Date.now();
    const deadline = started + GAP_SCAN_RESERVE_MS + 1_000;
    const result = await runAlarmChecks(sb, deadline, AbortSignal.timeout(GAP_SCAN_RESERVE_MS + 1_000));
    const by = reported(rpcs);
    for (const check of ["indexer-queue", "event-queue", "indexer-degraded", "worker-retry", "capacity-holds", "gap-scan-overdue"]) {
      expect(by[check], check).toBeDefined();
    }
    expect(result.gapScan).toMatchObject({ ran: true, cutShort: false });
    expect(by["gap-scan-incomplete"]).toBe("pass/medium");
    // The watches ran out of their budget (the checks deadline minus their reserve): one check that could not run.
    expect(result.expected).toBe(result.reports.length + 1);
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
    created_at: minutesAgo(24 * 60), reconcile_max_age_hours: 168,
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
    // Also when the heartbeat has never proved (no last_proven_at): the job stamp alone counts.
    expect((await run({ indexer_sync_state: ready(0.5), indexer_heartbeat_state: hb("on", null, "PENDING_JOBS") })).state).toBe("pass/medium");
  });

  it("passes when off; holds when it never ran or the indexer is not ready (indexer-degraded owns that)", async () => {
    expect((await run({ indexer_sync_state: ready(60), indexer_heartbeat_state: hb("off", null) })).state).toBe("pass/low");
    expect((await run({ indexer_sync_state: ready(60), indexer_heartbeat_state: [] })).state).toBe("hold/low");
    expect((await run({ indexer_sync_state: ready(60), indexer_heartbeat_state: [{ mode: "on", last_attempt_at: null, created_at: minutesAgo(10) }] }))
      .state).toBe("hold/medium");
    expect((await run({ indexer_sync_state: [{ status: "degraded", checked_at: minutesAgo(60), completed_at: minutesAgo(600) }],
      indexer_heartbeat_state: hb("on", 60) })).state).toBe("hold/medium");
  });

  it("a heartbeat that never records a run (every plan or confirm call failing) holds only for 30 minutes after its row was created", async () => {
    const never = (createdMinutesAgo: number) => [{ mode: "on", last_attempt_at: null, last_proven_at: null, created_at: minutesAgo(createdMinutesAgo) }];
    expect((await run({ indexer_sync_state: ready(60), indexer_heartbeat_state: never(29) })).state).toBe("hold/medium");
    const failed = await run({ indexer_sync_state: ready(60), indexer_heartbeat_state: never(31) });
    expect(failed.state).toBe("fail/medium");
    expect(failed.report?.args).toMatchObject({ p_evidence: { recorded: false, minutes_since_proof: 60 } });
    expect(String(failed.report?.args.p_summary)).toContain("has not recorded a run");
    // Jobs keeping the mirror fresh still pass (a busy network needs no heartbeat).
    expect((await run({ indexer_sync_state: ready(0.5), indexer_heartbeat_state: never(31) })).state).toBe("pass/medium");
  });

  it("indexer-reconcile-age (low): fails when the last full reconcile is older than reconcile_max_age_hours, never gates freshness", async () => {
    const age = async (sync: Record<string, unknown>[], heartbeat: Record<string, unknown>[]) => {
      const { sb, rpcs } = mockSb({ worker_heartbeats: [{ last_ok_at: minutesAgo(1), last_gap_scan_at: minutesAgo(1) }],
        indexer_sync_state: sync, indexer_heartbeat_state: heartbeat });
      await runAlarmChecks(sb, Date.now() + 10_000, AbortSignal.timeout(10_000));
      const find = (check: string) => rpcs.find((r) => r.fn === "report_incident" && r.args.p_check === check);
      const r = find("indexer-reconcile-age");
      return { reconcile: r ? `${r.args.p_state}/${r.args.p_severity}` : undefined, args: r?.args,
        freshness: find("indexer-freshness")?.args.p_state };
    };
    const synced = (hoursAgo: number | null) => [{ status: "ready", checked_at: minutesAgo(1),
      completed_at: hoursAgo === null ? null : minutesAgo(hoursAgo * 60) }];
    expect((await age(synced(10), hb("on", 1))).reconcile).toBe("pass/low");
    const old = await age(synced(200), hb("on", 1));
    expect(old).toMatchObject({ reconcile: "fail/low", freshness: "pass" });
    expect(old.args).toMatchObject({ p_source: "indexer:reconcile-age", p_evidence: { hours_since_reconcile: 200, max_age_hours: 168 } });
    expect((await age(synced(200), [{ ...hb("on", 1)[0], reconcile_max_age_hours: 720 }])).reconcile).toBe("pass/low");
    expect((await age(synced(null), hb("on", 1))).reconcile).toBe("fail/low");
    expect((await age(synced(200), hb("off", null))).reconcile).toBe("fail/low");
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

// v1.0.0-rc (8.3): the "timelock running" incident over the 0079 mirror, and
// the mainnet payout-modules invariant (D2).
describe("role-change-pending and payout-modules", () => {
  const nowSec = () => Math.floor(Date.now() / 1000);
  const heartbeats = { worker_heartbeats: [{ last_ok_at: minutesAgo(1), last_gap_scan_at: minutesAgo(1) }] };
  const incident = (rpcs: Rpc[], check: string) => rpcs.find((r) => r.fn === "report_incident" && r.args.p_check === check)?.args;

  it("opens (high) while a staged grant, Super Admin rotation or recovery is live, and names the next eta", async () => {
    const eta = nowSec() + 3_600;
    const { sb, rpcs } = mockSb({ ...heartbeats,
      pending_admins: [{ eta, expires_at: eta + 1_209_600 }, { eta: nowSec() - 10, expires_at: nowSec() - 1 }],
      authority_proposals: [{ kind: 0, eta: eta + 60, expires_at: eta + 99_999 }, { kind: 1, eta: 0, expires_at: eta }],
      platform_recoveries: [], blocklist_recoveries: [{ eta: nowSec() - 5, expires_at: nowSec() + 60 }] });
    const result = await runAlarmChecks(sb, Date.now() + 10_000, AbortSignal.timeout(10_000));
    expect(result.reports.length).toBe(result.expected);
    const args = incident(rpcs, "role-change-pending");
    expect(args).toMatchObject({ p_state: "fail", p_severity: "high", p_category: "onchain", p_source: "onchain:role-change-pending",
      p_evidence: { admin_grants: 1, platform_rotations: 1, platform_recoveries: 0, blocklist_recoveries: 1, next_eta: eta } });
    expect(String(args?.p_summary)).toMatch(/1 Admin grant, 1 Super Admin rotation, 1 blocklist authority recovery; the next becomes executable at .+ UTC/);
  });

  it("passes when nothing live is left (expired or custody rotations only); reports nothing before 0079", async () => {
    const quiet = mockSb({ ...heartbeats, pending_admins: [{ eta: 1, expires_at: nowSec() - 1 }], authority_proposals: [{ kind: 2, eta: 1, expires_at: nowSec() + 60 }] });
    await runAlarmChecks(quiet.sb, Date.now() + 10_000, AbortSignal.timeout(10_000));
    expect(incident(quiet.rpcs, "role-change-pending")).toMatchObject({ p_state: "pass", p_evidence: { admin_grants: 0, platform_rotations: 0 } });
    const before = mockSb(heartbeats, ["platform_recoveries"], {}, { platform_recoveries: "42P01" });
    const result = await runAlarmChecks(before.sb, Date.now() + 10_000, AbortSignal.timeout(10_000));
    expect(incident(before.rpcs, "role-change-pending")).toBeUndefined();
    expect(result.reports.length).toBe(result.expected);
    const down = mockSb(heartbeats, ["pending_admins"]);
    const partial = await runAlarmChecks(down.sb, Date.now() + 10_000, AbortSignal.timeout(10_000));
    expect(incident(down.rpcs, "role-change-pending")).toBeUndefined();
    expect(partial.expected).toBe(partial.reports.length + 1);
  });

  it("payout-modules: mainnet must keep 0x40 set (critical); other networks pass", async () => {
    const report = async (platforms: Record<string, unknown>[], network: "mainnet" | "devnet" = "mainnet", broken: string[] = []) =>
      payoutModulesReport(mockSb({ platforms }, broken).sb, network, AbortSignal.timeout(5_000));
    expect(await report([{ pause_flags: 0x40 }])).toMatchObject({ state: "pass", severity: "critical", source: "onchain:payout-modules" });
    expect(await report([{ pause_flags: 0x3f }])).toMatchObject({ state: "fail", severity: "critical", evidence: { pause_flags: 0x3f } });
    expect(await report([])).toMatchObject({ state: "hold" });
    expect(await report([{ pause_flags: 0 }], "devnet")).toMatchObject({ state: "pass" });
    expect(await report([{ pause_flags: 0x40 }], "mainnet", ["platforms"])).toBeNull();
    // Recorded with the other cheap checks (devnet here).
    const { sb, rpcs } = mockSb(heartbeats);
    await runAlarmChecks(sb, Date.now() + 10_000, AbortSignal.timeout(10_000));
    expect(incident(rpcs, "payout-modules")).toMatchObject({ p_state: "pass", p_severity: "critical" });
  });

  it("bootstrap-open: on mainnet bit 0x80 next to a clear emergency area fails (critical); the bootstrap itself passes", async () => {
    const report = async (platforms: Record<string, unknown>[], network: "mainnet" | "devnet" = "mainnet", broken: string[] = []) =>
      bootstrapOpenReport(mockSb({ platforms }, broken).sb, network, AbortSignal.timeout(5_000));
    // After an rc.x rollback that unpaused: bit 7 still set, areas clear.
    expect(await report([{ pause_flags: 0x80 | 0x40 }])).toMatchObject({ state: "fail", severity: "critical", source: "onchain:bootstrap-open", evidence: { pause_flags: 0xc0 } });
    expect(await report([{ pause_flags: 0x80 | 0x40 | 0x1c }])).toMatchObject({ state: "fail" });
    // The bootstrap (0xff: every area paused) and a closed window pass.
    expect(await report([{ pause_flags: 0xff }])).toMatchObject({ state: "pass", summary: expect.stringMatching(/bootstrap/) });
    expect(await report([{ pause_flags: 0x5c }])).toMatchObject({ state: "pass", summary: "The bootstrap window is closed" });
    expect(await report([])).toMatchObject({ state: "hold" });
    expect(await report([{ pause_flags: 0xc0 }], "devnet")).toMatchObject({ state: "pass" });
    expect(await report([{ pause_flags: 0xc0 }], "mainnet", ["platforms"])).toBeNull();
    expect(SOURCE_LABELS["onchain:bootstrap-open"]).toMatchObject({ format: "platform" });
    // Recorded with the other cheap checks (devnet here).
    const { sb, rpcs } = mockSb(heartbeats);
    await runAlarmChecks(sb, Date.now() + 10_000, AbortSignal.timeout(10_000));
    expect(incident(rpcs, "bootstrap-open")).toMatchObject({ p_state: "pass", p_severity: "critical" });
  });

  it("bootstrap-open: a fully paused window fails once it is 72 hours past the Platform's first indexed transaction (K1.11)", async () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
    const reads: string[] = [];
    const sb = (events: Record<string, unknown>[], flags = 0xff, broken = false) => ({ from: (table: string) => {
      const b: Record<string, unknown> = {};
      b.select = () => b; b.order = () => b; b.limit = () => b; b.abortSignal = () => b;
      b.eq = (column: string, value: unknown) => { reads.push(`${table}:${column}=${value}`); return b; };
      b.contains = (column: string, value: unknown[]) => { reads.push(`${table}:${column}@>${value.join(",")}`); return b; };
      b.maybeSingle = async () => table === "platforms" ? { data: { pda: MINT, pause_flags: flags }, error: null }
        : broken ? { data: null, error: { code: "08006" } } : { data: events[0] ?? null, error: null };
      return b;
    } }) as never;
    const report = (events: Record<string, unknown>[], flags = 0xff, broken = false, network: "mainnet" | "devnet" = "mainnet") =>
      bootstrapOpenReport(sb(events, flags, broken), network, AbortSignal.timeout(5_000), now);
    // Day D and the two days after it: the bootstrap.
    expect(await report([{ block_time: at(71.9), created_at: at(71) }])).toMatchObject({ state: "pass", evidence: { hours_open: 71 } });
    expect(reads).toEqual(["platforms:network=mainnet", "indexer_events:network=mainnet", `indexer_events:wallets@>${MINT}`]);
    // 72 hours after initialize_platform, still fully paused with bit 7 open: S5c was forgotten.
    expect(await report([{ block_time: at(72), created_at: at(71) }])).toMatchObject({ state: "fail", severity: "critical",
      source: "onchain:bootstrap-open", summary: expect.stringMatching(/open for 72 hours.*S5c/),
      evidence: { pause_flags: 0xff, opened_at: at(72), hours_open: 72, max_hours: 72 } });
    // No block time: the row's insert time.
    expect(await report([{ block_time: null, created_at: at(100) }])).toMatchObject({ state: "fail", evidence: { hours_open: 100 } });
    // No indexed transaction touched the Platform: passes as before; unreadable: the check could not run.
    expect(await report([])).toMatchObject({ state: "pass", summary: expect.stringMatching(/not indexed/) });
    expect(await report([], 0xff, true)).toBeNull();
    // A closed window reads no events; devnet never alarms.
    reads.length = 0;
    expect(await report([{ block_time: at(500) }], 0x5c)).toMatchObject({ state: "pass", summary: "The bootstrap window is closed" });
    expect(reads).toEqual(["platforms:network=mainnet"]);
    expect(await report([{ block_time: at(500) }], 0xff, false, "devnet")).toMatchObject({ state: "pass" });
  });

  it("primary-open-idle: 0x02 clear with no sale Open fails after an hour (high on mainnet), holds before, passes with a sale Open", async () => {
    const now = Date.parse("2026-10-03T12:00:00Z");
    const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
    const reads: string[] = [];
    // A precise fake: each read answers by its table and filters (open = status 0, closed = status 1).
    // The mirror behind each sale's issuer: class c → asset a → issuer i, class c2 → asset a2 → issuer i2 (share_classes,
    // assets); `freezes` are issuer_freezes rows (none by default).
    const links = {
      share_classes: [{ pda: "c", asset_pda: "a" }, { pda: "c2", asset_pda: "a2" }],
      assets: [{ pda: "a", issuer_pda: "i" }, { pda: "a2", issuer_pda: "i2" }],
    };
    const sb = (t: {
      flags?: number | null; platformAt?: string; open?: number; openRows?: Record<string, unknown>[]; alerts?: Record<string, unknown>[];
      closedAt?: string | null; broken?: string; freezes?: Record<string, unknown>[]; classes?: Record<string, unknown>[];
    }) => ({
      from: (table: string) => {
        const eqs: Record<string, unknown> = {};
        const ins: Record<string, unknown[]> = {};
        const b: Record<string, unknown> = {};
        b.select = () => b; b.order = () => b; b.limit = () => b;
        b.eq = (column: string, value: unknown) => { eqs[column] = value; return b; };
        b.in = (column: string, values: unknown[]) => { ins[column] = values; return b; };
        const within = (rows: Record<string, unknown>[]) =>
          rows.filter((r) => Object.entries(ins).every(([column, values]) => values.includes(r[column])));
        const rows = () => {
          if (t.broken === table) return { data: null, error: { code: "08006" } };
          reads.push(`${table}${eqs.status !== undefined ? `:status=${eqs.status}` : ""}`);
          if (table === "platforms") return { data: t.flags === null ? null : { pause_flags: t.flags ?? 0x7c, updated_at: t.platformAt ?? ago(500) }, error: null };
          if (table === "sales" && eqs.status === 0) return { data: t.openRows ?? Array.from({ length: t.open ?? 0 }, (_, i) => ({ pda: `s${i}` })), error: null };
          if (table === "sales" && eqs.status === 1) return { data: t.closedAt ? [{ updated_at: t.closedAt }] : [], error: null };
          if (table === "compliance_alerts") return { data: t.alerts ?? [], error: null };
          if (table === "share_classes") return { data: within(t.classes ?? links.share_classes), error: null };
          if (table === "assets") return { data: within(links.assets), error: null };
          if (table === "issuer_freezes") return { data: within(t.freezes ?? []), error: null };
          return { data: [], error: null };
        };
        b.abortSignal = () => ({
          maybeSingle: async () => rows(),
          then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve().then(rows).then(resolve, reject),
        });
        return b;
      },
    }) as never;
    const run = (t: Parameters<typeof sb>[0], network: "mainnet" | "devnet" = "mainnet") => primaryIdleReport(sb(t), network, AbortSignal.timeout(5_000), now);

    // 0x02 set: pass, nothing else read.
    reads.length = 0;
    expect(await run({ flags: 0x7e })).toMatchObject({ state: "pass", source: "onchain:primary-open-idle", severity: "high" });
    expect(reads).toEqual(["platforms"]);
    // A sale Open needs it: pass.
    expect(await run({ flags: 0x7c, open: 1 })).toMatchObject({ state: "pass" });
    // Cleared 30 minutes ago (the onchain:pause alert of a clear of bit 0x02), no sale Open yet: hold.
    const cleared = (minutes: number) => [{ created_at: ago(minutes), evidence: { set_mask: 0, clear_mask: 0x02 } }];
    expect(await run({ flags: 0x7c, alerts: cleared(30) })).toMatchObject({ state: "hold", evidence: { minutes_idle: 30 } });
    // …and 61 minutes ago: fail, high on mainnet, low elsewhere.
    expect(await run({ flags: 0x7c, alerts: cleared(61) })).toMatchObject({ state: "fail", severity: "high", summary: expect.stringMatching(/no sale Open for 61 minutes/) });
    expect(await run({ flags: 0x7c, alerts: cleared(61) }, "devnet")).toMatchObject({ state: "fail", severity: "low" });
    // A clear of another bit does not count; the last sale's close does (the newest of both wins).
    expect(await run({ flags: 0x7c, alerts: [{ created_at: ago(5), evidence: { clear_mask: 0x20 } }, ...cleared(120)] })).toMatchObject({ state: "fail" });
    expect(await run({ flags: 0x7c, alerts: cleared(120), closedAt: ago(10) })).toMatchObject({ state: "hold", evidence: { minutes_idle: 10 } });
    // Neither known: the Platform mirror's own update time.
    expect(await run({ flags: 0x7c, platformAt: ago(20) })).toMatchObject({ state: "hold" });
    expect(await run({ flags: 0x7c, platformAt: ago(90) })).toMatchObject({ state: "fail" });
    // An Open sale counts only while it can take a buy. One that ended is waiting to be closed (close_sale does not
    // need 0x02): idle since its end; numeric columns arrive as numbers or digit strings.
    const nowSec = Math.floor(now / 1000);
    const sale = (over: Record<string, unknown>) => ({ pda: "s", share_class_pda: "c", end_ts: nowSec + 86_400, sold: "10", total_for_sale: "100", updated_at: ago(500), ...over });
    expect(await run({ flags: 0x7c, openRows: [sale({})] })).toMatchObject({ state: "pass" });
    const ended = await run({ flags: 0x7c, openRows: [sale({ end_ts: nowSec - 30 * 60 })], alerts: cleared(600) });
    expect(ended).toMatchObject({ state: "hold", evidence: { minutes_idle: 30, open_sales_not_taking_buys: 1 }, summary: expect.stringMatching(/no sale taking buys \(1 Open sale ended or sold out/) });
    expect(await run({ flags: 0x7c, openRows: [sale({ end_ts: String(nowSec - 2 * 3600) })], alerts: cleared(600) })).toMatchObject({ state: "fail", evidence: { minutes_idle: 120 } });
    // Ended only by our clock, inside the chain-clock margin: it may still take a buy.
    expect(await run({ flags: 0x7c, openRows: [sale({ end_ts: nowSec - 60 })], alerts: cleared(600) })).toMatchObject({ state: "pass" });
    // Sold out: idle since its last update (the last buy); one live sale among idle ones still passes.
    expect(await run({ flags: 0x7c, openRows: [sale({ sold: 100, updated_at: ago(90) })], alerts: cleared(600) })).toMatchObject({ state: "fail", evidence: { minutes_idle: 90 } });
    expect(await run({ flags: 0x7c, openRows: [sale({ sold: 100, updated_at: ago(90) }), sale({ pda: "s2" })] })).toMatchObject({ state: "pass" });
    // A mirrored row whose columns cannot be read counts as a sale taking buys (the columns are NOT NULL; as before this check).
    expect(await run({ flags: 0x7c, openRows: [sale({ end_ts: null })] })).toMatchObject({ state: "pass" });
    // A frozen issuer's Open sale takes no buy (buy.rs IssuerProceedsFrozen): issuer B frozen to reopen 0x02 for sale A,
    // A closed 90 minutes ago, B's sale still Open → fail, idle since the newest of A's close and the freeze.
    const frozenB = [{ issuer_pda: "i", frozen_at: String(nowSec - 3 * 3600) }];
    const frozen = await run({ flags: 0x7c, openRows: [sale({})], freezes: frozenB, alerts: cleared(600), closedAt: ago(90) });
    expect(frozen).toMatchObject({
      state: "fail",
      evidence: { minutes_idle: 90, open_sales_not_taking_buys: 1, issuer_frozen: 1, freeze_unread: 0 },
      summary: expect.stringMatching(/no sale taking buys \(1 Open sale of a frozen issuer\) for 90 minutes/),
    });
    // …and within the hour: hold; frozen 20 minutes ago (after every clear and close): idle since the freeze.
    expect(await run({ flags: 0x7c, openRows: [sale({})], freezes: frozenB, alerts: cleared(600), closedAt: ago(30) })).toMatchObject({ state: "hold", evidence: { minutes_idle: 30 } });
    expect(await run({ flags: 0x7c, openRows: [sale({})], freezes: [{ issuer_pda: "i", frozen_at: nowSec - 20 * 60 }], alerts: cleared(600) }))
      .toMatchObject({ state: "hold", evidence: { minutes_idle: 20 } });
    // Another issuer's live sale beside the frozen one still needs 0x02: pass.
    expect(await run({ flags: 0x7c, openRows: [sale({}), sale({ pda: "s2", share_class_pda: "c2" })], freezes: frozenB })).toMatchObject({ state: "pass" });
    // Frozen and ended: ended wins (idle since its end).
    expect(await run({ flags: 0x7c, openRows: [sale({ end_ts: nowSec - 2 * 3600 })], freezes: frozenB, alerts: cleared(600) }))
      .toMatchObject({ state: "fail", evidence: { minutes_idle: 120, issuer_frozen: 0, open_sales_not_taking_buys: 1 } });
    // An issuer the mirror cannot resolve never keeps the alarm at pass (the re-pause side of safety), said in the summary.
    const unresolved = await run({ flags: 0x7c, openRows: [sale({ share_class_pda: "unknown" })], alerts: cleared(61) });
    expect(unresolved).toMatchObject({
      state: "fail",
      evidence: { minutes_idle: 61, freeze_unread: 1 },
      summary: expect.stringMatching(/1 Open sale whose issuer's freeze is not in the mirror/),
    });
    expect(await run({ flags: 0x7c, openRows: [sale({})], classes: [{ pda: "c", asset_pda: null }], alerts: cleared(30) })).toMatchObject({ state: "hold", evidence: { freeze_unread: 1 } });
    // The freeze mirror unreadable: the check could not run (never a silent pass).
    expect(await run({ flags: 0x7c, openRows: [sale({})], broken: "issuer_freezes" })).toBeNull();
    expect(await run({ flags: 0x7c, openRows: [sale({})], broken: "share_classes" })).toBeNull();
    expect(await run({ flags: 0x7c, openRows: [sale({})], broken: "assets" })).toBeNull();
    // Only a sale that would take a buy by its window needs the freeze: an ended one reads no link.
    reads.length = 0;
    await run({ flags: 0x7c, openRows: [sale({ end_ts: nowSec - 2 * 3600 })], alerts: cleared(600) });
    expect(reads.filter((r) => ["share_classes", "assets", "issuer_freezes"].includes(r))).toEqual([]);
    // No Platform mirrored: hold; unreadable: the check could not run.
    expect(await run({ flags: null })).toMatchObject({ state: "hold" });
    expect(await run({ flags: 0x7c, broken: "sales" })).toBeNull();
    expect(await run({ flags: 0x7c, broken: "compliance_alerts" })).toBeNull();
    expect(SOURCE_LABELS["onchain:primary-open-idle"]).toMatchObject({ format: "platform" });
    // Recorded with the other cheap checks.
    const { sb: mock, rpcs } = mockSb(heartbeats);
    await runAlarmChecks(mock, Date.now() + 10_000, AbortSignal.timeout(10_000));
    expect(incident(rpcs, "primary-open-idle")).toBeDefined();
  });

  it("roleChangesReport reads only this network's rows", async () => {
    const calls: string[] = [];
    const sb = { from: (table: string) => {
      const b: Record<string, unknown> = {};
      b.select = () => b; b.limit = () => b;
      b.eq = (column: string, value: string) => { calls.push(`${table}:${column}=${value}`); return b; };
      b.abortSignal = async () => ({ data: [], error: null });
      return b;
    } };
    expect(await roleChangesReport(sb as never, "devnet", Date.now(), AbortSignal.timeout(5_000))).toMatchObject([{ state: "pass" }]);
    expect(calls).toEqual(["pending_admins:network=devnet", "authority_proposals:network=devnet", "platform_recoveries:network=devnet",
      "blocklist_recoveries:network=devnet"]);
  });
});

describe("automatic EUR rate (0080)", () => {
  const usdc = USDC.devnet!.mint;
  const sources = (down: string[] = []) => Object.fromEntries(["kraken", "coinbase", "bitstamp", "bitvavo"]
    .map((id) => [id, down.includes(id) ? { error: "TIMEOUT" } : { rate: "0.889" }]));
  const accepted = (minutes: number, rate = "0.889", down: string[] = []) =>
    ({ observed_at: minutesAgo(minutes), status: "accepted", code: null, eur_per_token: rate, quotes: { sources: sources(down) } });
  const refusedObs = (minutes: number, code: string) =>
    ({ observed_at: minutesAgo(minutes), status: "refused", code, eur_per_token: null,
      quotes: { sources: sources(), median: "0.86", ecb_deviation_bps: 300, ecb_tolerance_bps: 250, ecb: { date: "2026-10-02" } } });
  const autoRow = (minutes: number) => ({ payment_mint: usdc, eur_per_token: "0.889", decimals: 6, source: "auto", as_of: minutesAgo(minutes), max_age: "00:15:00" });
  const manualRow = (days: number) => ({ payment_mint: usdc, kind: "rate", eur_per_token: "0.9", decimals: 6, as_of: minutesAgo(days * 24 * 60), max_age: "7 days" });
  const reportsOn = async (network: "devnet" | "mainnet", tables: Record<string, Record<string, unknown>[]>, broken: string[] = [],
    codes: Record<string, string> = {}) => {
    const { sb } = mockSb(tables, broken, {}, codes);
    const result = await fxAutoReports(sb, network, Date.now(), AbortSignal.timeout(5_000));
    return result === null ? null : Object.fromEntries(result.map((r) => [r.check.split(":")[0], r]));
  };
  const reports = (tables: Record<string, Record<string, unknown>[]>, broken: string[] = [], codes: Record<string, string> = {}) =>
    reportsOn("devnet", tables, broken, codes);
  /** One observation a minute for the last `minutes` minutes. */
  const everyMinute = (minutes: number, make: (m: number) => Record<string, unknown>) =>
    Array.from({ length: minutes }, (_, i) => make(i));

  it("nothing before the fx scheduler has run, nothing before 0080, and an unreadable table is a check that could not run", async () => {
    expect(await reports({})).toEqual({});
    expect(await reports({}, ["fx_auto_rates"], { fx_auto_rates: "42P01" })).toEqual({});
    expect(await reports({ fx_auto_rates: [autoRow(1)] }, ["fx_rate_observations"])).toBeNull();
  });

  it("all well: every check passes", async () => {
    const by = (await reports({ fx_auto_rates: [autoRow(1)], fx_rates: [manualRow(1)],
      fx_rate_observations: everyMinute(20, (m) => accepted(m)) }))!;
    expect(Object.fromEntries(Object.entries(by).map(([k, r]) => [k, `${r.state}/${r.severity}`]))).toEqual({
      "fx-auto-stale": "pass/low", "fx-fallback": "pass/medium", "fx-source-down": "pass/medium", "fx-depeg": "pass/high",
      "fx-divergence": "pass/medium", "fx-jump": "pass/medium",
    });
    expect(by["fx-auto-stale"]).toMatchObject({ check: `fx-auto-stale:${usdc}`, source: "fx:auto-stale", category: "fx" });
  });

  it("fx-auto-stale off mainnet: low (never emailed), whether or not a fresh manual rate covers it", async () => {
    const observations = everyMinute(20, (m) => refusedObs(m, "TOO_FEW_SOURCES"));
    let by = (await reports({ fx_auto_rates: [autoRow(20)], fx_rates: [manualRow(1)], fx_rate_observations: observations }))!;
    expect(by["fx-auto-stale"]).toMatchObject({ state: "fail", severity: "low",
      summary: expect.stringMatching(/20 minute\(s\) old \(runs refused: TOO_FEW_SOURCES\); the manual rate on \/admin\/limits counts/),
      evidence: { last_refusal: "TOO_FEW_SOURCES", manual_fallback: true } });
    by = (await reports({ fx_auto_rates: [autoRow(20)], fx_rates: [manualRow(8)], fx_rate_observations: observations,
      sales: [{ payment_mint: usdc }] }))!;
    expect(by["fx-auto-stale"]).toMatchObject({ state: "fail", severity: "low", summary: expect.stringMatching(/no fresh manual rate/) });
    // The job stopped altogether: no observation in the last hour.
    by = (await reports({ fx_auto_rates: [autoRow(90)] }))!;
    expect(by["fx-auto-stale"]).toMatchObject({ state: "fail", severity: "low", summary: expect.stringMatching(/has not run in the last hour/) });
    expect(by["fx-source-down"]).toBeUndefined();
  });

  it("fx-auto-stale on mainnet: high only for a mint in use with nothing fresh left; medium otherwise", async () => {
    const mainnetUsdc = USDC.mainnet!.mint;
    const auto = { ...autoRow(20), payment_mint: mainnetUsdc };
    const observations = everyMinute(20, (m) => refusedObs(m, "TOO_FEW_SOURCES"));
    const stale = async (tables: Record<string, Record<string, unknown>[]>) =>
      (await reportsOn("mainnet", { fx_auto_rates: [auto], fx_rate_observations: observations, ...tables }))!["fx-auto-stale"];
    // In use (the same notion as fx-stale): a live approval, an open sale or a raise limit hold paid in the mint.
    const inUseBy: Record<string, Record<string, unknown>[]>[] = [
      { sale_capacity_reservations: [{ payment_mint: mainnetUsdc }] },
      { sales: [{ payment_mint: mainnetUsdc }] },
      { sale_capacity_holds: [{ payment_mint: mainnetUsdc }] },
    ];
    for (const inUse of inUseBy) {
      expect(await stale({ fx_rates: [manualRow(8)], ...inUse })).toMatchObject({ state: "fail", severity: "high",
        check: `fx-auto-stale:${mainnetUsdc}`, evidence: { in_use: true, manual_fallback: false } });
      // A fresh manual rate covers it: medium.
      expect(await stale({ fx_rates: [manualRow(1)], ...inUse })).toMatchObject({ state: "fail", severity: "medium" });
    }
    // Nothing paid in it yet (launch day before the first sale), or only another mint in use: medium.
    expect(await stale({ fx_rates: [manualRow(8)] })).toMatchObject({ state: "fail", severity: "medium", evidence: { in_use: false } });
    expect(await stale({ sales: [{ payment_mint: usdc }] })).toMatchObject({ state: "fail", severity: "medium" });
    // The in-use reads fail: the check could not run.
    expect(await reportsOn("mainnet", { fx_auto_rates: [auto], fx_rate_observations: observations }, ["sales"])).toBeNull();
  });

  it("no automatic row: fx-auto-stale fails only while the job evidently runs (the off switch clears within 5 minutes)", async () => {
    // The job runs but has never been accepted: missing.
    const refusing = (from: number) => everyMinute(20, (m) => refusedObs(m + from, "ECB_UNAVAILABLE"));
    let by = (await reports({ fx_rates: [manualRow(1)], fx_rate_observations: refusing(1) }))!;
    expect(by["fx-auto-stale"]).toMatchObject({ state: "fail", summary: expect.stringMatching(/is missing \(runs refused: ECB_UNAVAILABLE\)/) });
    // Off switch (job disabled, rows deleted): the latest run is 5 minutes old or older, every open incident passes.
    const open = { alarm_incidents: [{ check_key: `fx-auto-stale:${usdc}` }, { check_key: `fx-depeg:${usdc}` }] };
    by = (await reports({ ...open, fx_rates: [manualRow(1)], fx_rate_observations: refusing(5) }))!;
    expect(by).toEqual({
      "fx-auto-stale": expect.objectContaining({ state: "pass", check: `fx-auto-stale:${usdc}` }),
      "fx-depeg": expect.objectContaining({ state: "pass", check: `fx-depeg:${usdc}` }),
    });
    // With an automatic row, a stopped job is still a failure (its rate went stale).
    by = (await reports({ fx_auto_rates: [autoRow(20)], fx_rate_observations: refusing(5) }))!;
    expect(by["fx-auto-stale"].state).toBe("fail");
  });

  it("fx-source-down: a source without a usable answer for 15 minutes, only while the worker runs and has covered the window", async () => {
    let by = (await reports({ fx_auto_rates: [autoRow(1)], fx_rate_observations: everyMinute(20, (m) => accepted(m, "0.889", ["coinbase"])) }))!;
    expect(by["fx-source-down"]).toMatchObject({ state: "fail", severity: "medium", evidence: { down: ["coinbase"] },
      summary: expect.stringMatching(/coinbase/) });
    // Down for 10 minutes only: not yet.
    by = (await reports({ fx_auto_rates: [autoRow(1)],
      fx_rate_observations: everyMinute(20, (m) => accepted(m, "0.889", m < 10 ? ["coinbase"] : [])) }))!;
    expect(by["fx-source-down"].state).toBe("pass");
    // Ten minutes of history: the window is not covered yet.
    by = (await reports({ fx_auto_rates: [autoRow(1)], fx_rate_observations: everyMinute(10, (m) => accepted(m, "0.889", ["coinbase"])) }))!;
    expect(by["fx-source-down"]).toBeUndefined();
  });

  it("fx-depeg (high) and fx-divergence (medium): hold on the first refusals, fail after three in a row, pass once accepted", async () => {
    const run = async (codes: string[]) => (await reports({ fx_auto_rates: [autoRow(5)],
      fx_rate_observations: [...codes.map((c, i) => refusedObs(i, c)), ...everyMinute(10, (m) => accepted(m + codes.length))] }))!;
    let by = await run(["ECB_DEVIATION", "ECB_DEVIATION"]);
    expect(by["fx-depeg"]).toMatchObject({ state: "hold", severity: "high" });
    by = await run(["ECB_DEVIATION", "ECB_DEVIATION", "ECB_DEVIATION"]);
    expect(by["fx-depeg"]).toMatchObject({ state: "fail", severity: "high", source: "fx:depeg",
      summary: expect.stringMatching(new RegExp("deviates from the ECB reference of 2026-10-02 by more than the tolerance \\(2\\.50 %\\) "
        + "— a USDC depeg, a large EUR/USD move since the fix, or broken sources; 3 run\\(s\\) refused on the prices")),
      evidence: { refused_in_a_row: 3, recent_codes: ["ECB_DEVIATION", "ECB_DEVIATION", "ECB_DEVIATION"], ecb_deviation_bps: 300,
        ecb_tolerance_bps: 250 } });
    expect(by["fx-divergence"].state).toBe("pass");
    by = await run(["SOURCE_DIVERGENCE", "SOURCE_DIVERGENCE", "SOURCE_DIVERGENCE", "ECB_DEVIATION"]);
    expect(by["fx-divergence"]).toMatchObject({ state: "fail", severity: "medium", source: "fx:divergence" });
    expect(by["fx-depeg"].state).toBe("pass");
    expect(marketRefusals([{ status: "accepted", code: null }, { status: "refused", code: "ECB_DEVIATION" }])).toEqual([]);
  });

  it("a real depeg alternates ECB_DEVIATION and SOURCE_DIVERGENCE (books lag each other): fx-depeg still fails", async () => {
    const run = async (codes: string[]) => (await reports({ fx_auto_rates: [autoRow(5)], fx_rates: [manualRow(1)],
      fx_rate_observations: [...codes.map((c, i) => refusedObs(i, c)), ...everyMinute(10, (m) => accepted(m + codes.length))] }))!;
    let by = await run(["SOURCE_DIVERGENCE", "ECB_DEVIATION", "SOURCE_DIVERGENCE", "ECB_DEVIATION"]);
    expect(by["fx-depeg"]).toMatchObject({ state: "fail", severity: "high",
      evidence: { refused_in_a_row: 4, recent_codes: ["SOURCE_DIVERGENCE", "ECB_DEVIATION", "SOURCE_DIVERGENCE"] } });
    // One condition, one alert: the divergence half of it holds (an open incident stays, none opens).
    expect(by["fx-divergence"].state).toBe("hold");
    // Refusals that judged no prices (a venue or the ECB not answering) neither end nor extend the run of verdicts.
    by = await run(["TOO_FEW_SOURCES", "ECB_DEVIATION", "ECB_UNAVAILABLE", "SOURCE_DIVERGENCE", "ECB_DEVIATION"]);
    expect(by["fx-depeg"]).toMatchObject({ state: "fail", evidence: { refused_in_a_row: 3 } });
    by = await run(["TOO_FEW_SOURCES", "TOO_FEW_SOURCES", "ECB_DEVIATION", "SOURCE_DIVERGENCE"]);
    expect(by["fx-depeg"].state).toBe("hold");
    expect(by["fx-divergence"].state).toBe("hold");
    expect(marketRefusals([
      { status: "refused", code: "SOURCE_DIVERGENCE" }, { status: "refused", code: "DECIMALS_UNAVAILABLE" },
      { status: "refused", code: "ECB_DEVIATION" }, { status: "accepted", code: null }, { status: "refused", code: "ECB_DEVIATION" },
    ])).toEqual(["SOURCE_DIVERGENCE", "ECB_DEVIATION"]);
  });

  it("fx-fallback: while the automatic rate counts, the manual rate behind it must be there and current", async () => {
    const observations = everyMinute(20, (m) => accepted(m));
    const fallback = async (tables: Record<string, Record<string, unknown>[]>) =>
      (await reports({ fx_auto_rates: [autoRow(1)], fx_rate_observations: observations, ...tables }))!["fx-fallback"];
    expect(await fallback({ fx_rates: [manualRow(1)] })).toMatchObject({ state: "pass", check: `fx-fallback:${usdc}` });
    // 1.6 days before the max age of a 7-day rate: within the 2-day warning.
    expect(await fallback({ fx_rates: [manualRow(5.4)] })).toMatchObject({ state: "fail", severity: "medium", source: "fx:fallback",
      category: "fx", summary: expect.stringMatching(/reaches its max age in 38 hour\(s\)/), evidence: { hours_left: 38 } });
    expect(await fallback({ fx_rates: [manualRow(8)] })).toMatchObject({ state: "fail", severity: "medium",
      summary: expect.stringMatching(/past its max age/) });
    expect(await fallback({ fx_rates: [{ ...manualRow(1), max_age: "soon" }] })).toMatchObject({ state: "fail" });
    // Missing: low (never emailed) off mainnet, medium on mainnet (D10 keeps one).
    expect(await fallback({})).toMatchObject({ state: "fail", severity: "low", summary: expect.stringMatching(/No manual EUR rate/) });
    const mainnetUsdc = USDC.mainnet!.mint;
    const { sb } = mockSb({ fx_auto_rates: [{ ...autoRow(1), payment_mint: mainnetUsdc }], fx_rate_observations: observations });
    const onMainnet = (await fxAutoReports(sb, "mainnet", Date.now(), AbortSignal.timeout(5_000)))!
      .find((r) => r.check === `fx-fallback:${mainnetUsdc}`);
    expect(onMainnet).toMatchObject({ state: "fail", severity: "medium" });
    // The manual row counts by itself (an override, a peg) or because the automatic rate is stale: other checks judge it.
    expect(await fallback({ fx_rates: [{ ...manualRow(8), override_auto: true }] })).toMatchObject({ state: "pass" });
    expect(await fallback({ fx_rates: [{ ...manualRow(8), kind: "eur_peg" }] })).toMatchObject({ state: "pass" });
    expect((await reports({ fx_auto_rates: [autoRow(20)], fx_rates: [manualRow(8)], fx_rate_observations: observations }))!["fx-fallback"])
      .toMatchObject({ state: "pass", evidence: { auto_fresh: false } });
  });

  it("fx-jump: accepted rates moving more than 1 % within an hour fail, more than 0.5 % hold", async () => {
    const run = async (rates: string[]) => (await reports({ fx_auto_rates: [autoRow(1)],
      fx_rate_observations: rates.map((r, i) => accepted(i * 5, r)) }))!["fx-jump"];
    expect(await run(["0.889", "0.8895", "0.8885"])).toMatchObject({ state: "pass" });
    expect(await run(["0.895", "0.889"])).toMatchObject({ state: "hold" });
    expect(await run(["0.9", "0.889"])).toMatchObject({ state: "fail", severity: "medium", source: "fx:jump",
      evidence: { move_bps: 124, min: 0.889, max: 0.9, accepted_runs: 2 } });
  });

  it("an earlier incident whose check no longer reports (the rows were deleted to switch it off) passes", async () => {
    const by = await reports({ alarm_incidents: [{ check_key: `fx-auto-stale:${usdc}` }, { check_key: `fx-stale:${usdc}` }] });
    expect(by).toEqual({ "fx-auto-stale": expect.objectContaining({ state: "pass", check: `fx-auto-stale:${usdc}` }) });
  });

  it("runAlarmChecks: a fresh automatic rate counts, so a stale manual row neither expires nor goes stale for a mint in use (fx-fallback reports it)", async () => {
    const { sb, rpcs } = mockSb({
      worker_heartbeats: [{ last_ok_at: minutesAgo(1), last_gap_scan_at: minutesAgo(1) }],
      fx_rates: [manualRow(8)],
      fx_auto_rates: [autoRow(1)],
      fx_rate_observations: everyMinute(20, (m) => accepted(m)),
      sales: [{ payment_mint: usdc }],
    });
    const result = await runAlarmChecks(sb, Date.now() + 10_000, AbortSignal.timeout(10_000));
    expect(result.reports.length).toBe(result.expected);
    const by = Object.fromEntries(rpcs.filter((r) => r.fn === "report_incident").map((r) => [r.args.p_check, r.args.p_state]));
    expect(by).toMatchObject({ [`fx-stale:${usdc}`]: "pass", [`fx-expiring:${usdc}`]: "pass", [`fx-auto-stale:${usdc}`]: "pass",
      [`fx-jump:${usdc}`]: "pass", [`fx-fallback:${usdc}`]: "fail" });
    // Every new source has an email label (platform format: public prices only).
    for (const source of ["fx:auto-stale", "fx:fallback", "fx:source-down", "fx:depeg", "fx:divergence", "fx:jump"]) {
      expect(SOURCE_LABELS[source]).toMatchObject({ format: "platform" });
    }
  });
});
