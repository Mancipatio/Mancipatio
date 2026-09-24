// Talas 4.4b: the alarm worker route — its own lease, deadlines, heartbeats
// before and after notify, counts only. Stages and Supabase are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ rpc: vi.fn(), events: vi.fn(), checks: vi.fn(), notify: vi.fn(), order: [] as string[] }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({ rpc: m.rpc }) }));
vi.mock("@/lib/network", () => ({ detectNetwork: () => "devnet" }));
vi.mock("@/lib/server/onchain-alarms", () => ({ reconcileEventJobs: m.events }));
vi.mock("@/lib/server/alarm-checks", () => ({ runAlarmChecks: m.checks }));
vi.mock("@/lib/server/system-alerts", () => ({ notifyPendingAlerts: m.notify }));
vi.mock("@/lib/server/indexer-sync", () => ({ reconcileIndexerJobs: vi.fn() }));
vi.mock("@/lib/server/purchase-records", () => ({ reconcilePurchases: vi.fn() }));
vi.mock("@/lib/server/sale-capacity", () => ({ reconcileSaleCapacity: vi.fn() }));
vi.mock("@/lib/server/spv-issuance-jobs", () => ({ reconcileLedger: vi.fn() }));
import { POST, maxDuration } from "@/app/api/internal/alarms/route";
import { ALARM_DEADLINES_MS, runAlarmWorker } from "@/lib/server/alarm-worker";

const SECRET = "fixture-scheduler-secret-32-characters-only";
const request = (auth: string | null = `Bearer ${SECRET}`) =>
  new Request("http://localhost/api/internal/alarms", { method: "POST", headers: auth ? { authorization: auth } : {} });
const result = (data: unknown = true, error: unknown = null) => ({ abortSignal: () => Promise.resolve({ data, error }) });

beforeEach(() => {
  vi.clearAllMocks(); m.order = [];
  vi.stubEnv("RETRY_WORKER_SECRET", SECRET);
  m.rpc.mockImplementation((fn: string, args: Record<string, unknown>) => {
    m.order.push(fn === "record_worker_heartbeat" ? `heartbeat:${args.p_status}` : fn);
    return result();
  });
  m.events.mockImplementation(async () => { m.order.push("events"); return { complete: 2, pending: 1, invalid: 0 }; });
  m.checks.mockImplementation(async () => { m.order.push("checks"); return { reports: [{ check: "x", state: "fail", severity: "high" }], gapScan: { ran: true } }; });
  m.notify.mockImplementation(async () => { m.order.push("notify"); return { status: "sent", count: 3 }; });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("alarm worker", () => {
  it("is authorized like the retry worker (same secret, D8)", async () => {
    expect((await POST(request(null))).status).toBe(401);
    expect((await POST(request("Bearer wrong"))).status).toBe(401);
    vi.stubEnv("RETRY_WORKER_SECRET", "");
    expect((await POST(request())).status).toBe(503);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("runs events, checks, a heartbeat, notify, a final heartbeat, then releases its own lease; counts only", async () => {
    const response = await POST(request());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(maxDuration).toBe(60);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(m.order).toEqual(["acquire_worker_lease", "events", "checks", "heartbeat:processed", "notify", "heartbeat:processed", "release_worker_lease"]);
    expect(m.rpc.mock.calls[0][1]).toMatchObject({ p_network: "devnet", p_worker: "alarms", p_ttl_seconds: 120 });
    expect(m.rpc.mock.calls.find((c) => c[0] === "record_worker_heartbeat")![1]).toMatchObject({ p_worker: "alarms", p_gap_scan: true });
    expect(body.data).toMatchObject({ status: "processed", network: "devnet", events: { counts: { complete: 2 } },
      checks: { counts: { reported: 1, failing: 1, gapScan: true } }, notify: { status: "sent", count: 3 } });
  });

  it("busy when another run holds the lease; 503 'Deployment network mismatch' when the lease refuses the network", async () => {
    m.rpc.mockImplementationOnce(() => result(false));
    expect((await (await POST(request())).json()).data).toEqual({ status: "busy", network: "devnet" });
    expect(m.events).not.toHaveBeenCalled();
    m.rpc.mockImplementationOnce(() => result(null, { code: "P0001", message: "DEPLOYMENT_NETWORK_MISMATCH database=mainnet deployment=devnet" }));
    const refused = await POST(request());
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ ok: false, error: "Deployment network mismatch" });
  });

  it("a failed stage is partial (503) with no internals; the heartbeat before notify says so", async () => {
    m.events.mockRejectedValue(new Error("internal-detail"));
    const response = await POST(request());
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body.data.events.status).toBe("failed");
    expect(JSON.stringify(body)).not.toContain("internal-detail");
    expect(m.order).toContain("heartbeat:partial");
    expect(m.notify).toHaveBeenCalled();
  });

  it("keeps the absolute deadlines: events +20 s, checks +30 s, notify by +40 s", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    m.events.mockImplementation(async (_l: number, deadline: number) => { expect(deadline).toBe(now + ALARM_DEADLINES_MS.events); now += 20_000; return { complete: 0, pending: 0, invalid: 0 }; });
    m.checks.mockImplementation(async (_sb: unknown, deadline: number) => { expect(deadline).toBe(1_000_000 + ALARM_DEADLINES_MS.checks); now += 10_000; return { reports: [], gapScan: null }; });
    m.notify.mockImplementation(async (deadline: number) => { expect(deadline).toBe(1_000_000 + ALARM_DEADLINES_MS.notifyEnd); return { status: "none" }; });
    expect((await runAlarmWorker()).status).toBe("processed");
  });
});
