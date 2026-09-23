import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkIdentityError } from "@/lib/network-identity";

vi.mock("server-only", () => ({}));

type Reply = { data: unknown; error: unknown; count?: number | null } | Error | "hang";
type Call = { table: string; select?: unknown[]; filters: unknown[][]; order?: unknown[]; limit?: number; signal?: AbortSignal };
const m = vi.hoisted(() => ({
  replies: {} as Record<string, Reply>,
  calls: [] as Call[],
  adminError: null as Error | null,
  rpcError: null as Error | null,
  rpcCalls: 0,
  rpcSend: (() => Promise.resolve(BigInt(0))) as (signal: AbortSignal) => Promise<unknown>,
  rpcSignal: null as AbortSignal | null,
  maintenance: vi.fn(),
}));

function from(table: string) {
  const call: Call = { table, filters: [] };
  m.calls.push(call);
  const settle = async () => {
    const reply = m.replies[table];
    if (reply === "hang") {
      return new Promise((_resolve, reject) => call.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    if (reply instanceof Error) throw reply;
    return reply;
  };
  const q: Record<string, unknown> = {};
  Object.assign(q, {
    select: (...args: unknown[]) => { call.select = args; return q; },
    eq: (...args: unknown[]) => { call.filters.push(args); return q; },
    order: (...args: unknown[]) => { call.order = args; return q; },
    limit: (n: number) => { call.limit = n; return q; },
    abortSignal: (signal: AbortSignal) => { call.signal = signal; return q; },
    maybeSingle: () => settle(),
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => settle().then(resolve, reject),
  });
  return q;
}
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => {
    if (m.adminError) throw m.adminError;
    return { from };
  },
}));
vi.mock("@/lib/server/rpc", () => ({
  getServerRpc: () => {
    if (m.rpcError) throw m.rpcError;
    return {
      getSlot: (config: unknown) => {
        expect(config).toEqual({ commitment: "confirmed" });
        return {
          send: ({ abortSignal }: { abortSignal: AbortSignal }) => {
            m.rpcCalls++;
            m.rpcSignal = abortSignal;
            return m.rpcSend(abortSignal);
          },
        };
      },
    };
  },
}));
vi.mock("@/lib/server/maintenance", () => ({ readMaintenance: m.maintenance }));

const NOW = new Date("2026-09-23T10:00:00Z").getTime();
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

type Route = typeof import("@/app/api/health/route");
let route: Route;
beforeEach(async () => {
  vi.resetModules();
  route = await import("@/app/api/health/route");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "0123456789abcdef0123456789abcdef01234567");
  m.calls = [];
  m.adminError = null;
  m.rpcError = null;
  m.rpcCalls = 0;
  m.rpcSignal = null;
  m.rpcSend = () => Promise.resolve(BigInt(412_345_678));
  m.replies = {
    indexer_sync_state: { data: { status: "ready", last_slot: 412_345_000, checked_at: ago(30), completed_at: ago(3600) }, error: null },
    indexer_jobs: { data: [], error: null, count: 0 },
    purchase_evidence_jobs: { data: [], error: null, count: 0 },
  };
  m.maintenance.mockReset();
  m.maintenance.mockResolvedValue({ enabled: false, message: null, fresh: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function get() {
  const response = await route.GET();
  return { status: response.status, headers: response.headers, body: await response.json() };
}

describe("GET /api/health", () => {
  it("answers 200 with every check when the deployment is healthy, never cached", async () => {
    const { status, headers, body } = await get();
    expect(status).toBe(200);
    expect(headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(body).toEqual({
      ok: true,
      network: "devnet",
      checkedAt: new Date(NOW).toISOString(),
      commit: "0123456789ab",
      checks: {
        indexer: { status: "ok", state: "ready", lastSlot: 412_345_000, checkedAgeSeconds: 30, completedAgeSeconds: 3600, fresh: true },
        rpc: { status: "ok", slot: 412_345_678, latencyMs: expect.any(Number) },
        indexerQueue: { status: "ok", pending: 0, oldestPendingAgeSeconds: null },
        purchaseQueue: { status: "ok", pending: 0, oldestPendingAgeSeconds: null },
        maintenance: { status: "ok", enabled: false },
      },
    });
    expect(m.maintenance).toHaveBeenCalledWith("devnet");
  });

  it("reads only the current network's state and pending queue rows, with a deadline", async () => {
    await get();
    const byTable = Object.fromEntries(m.calls.map((call) => [call.table, call]));
    expect(byTable.indexer_sync_state.filters).toEqual([["network", "devnet"]]);
    for (const table of ["indexer_jobs", "purchase_evidence_jobs"]) {
      expect(byTable[table].filters).toEqual([["network", "devnet"], ["status", "pending"]]);
      expect(byTable[table].select).toEqual(["created_at", { count: "exact" }]);
      expect(byTable[table].order).toEqual(["created_at", { ascending: true }]);
      expect(byTable[table].limit).toBe(1);
    }
    for (const call of m.calls) expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(m.rpcSignal).toBeInstanceOf(AbortSignal);
  });

  it("reports an unreachable database per check with 503 and without error details", async () => {
    m.replies.indexer_sync_state = new Error("fetch failed: db.secret-host.supabase.co");
    m.replies.indexer_jobs = { data: null, error: { code: "57014", message: "statement timeout on secret-host" }, count: null };
    m.replies.purchase_evidence_jobs = new Error("ECONNREFUSED 10.0.0.7");
    m.maintenance.mockResolvedValue({ enabled: false, message: null, fresh: false });
    const { status, body } = await get();
    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.checks.indexer).toMatchObject({ status: "fail", reason: "unavailable", state: null });
    expect(body.checks.indexerQueue).toMatchObject({ status: "fail", reason: "unavailable", pending: null });
    expect(body.checks.purchaseQueue).toMatchObject({ status: "fail", reason: "unavailable", pending: null });
    expect(body.checks.maintenance).toMatchObject({ status: "fail", reason: "unavailable" });
    expect(body.checks.rpc.status).toBe("ok");
    expect(JSON.stringify(body)).not.toMatch(/secret-host|10\.0\.0\.7|57014|timeout on/);
  });

  it("reports a missing service-role configuration instead of throwing", async () => {
    m.adminError = new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
    const { status, body } = await get();
    expect(status).toBe(503);
    for (const check of ["indexer", "indexerQueue", "purchaseQueue"])
      expect(body.checks[check]).toMatchObject({ status: "fail", reason: "not_configured" });
    expect(m.calls).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("never echoes RPC errors, which can carry the provider URL and API key", async () => {
    m.rpcSend = () => Promise.reject(new Error("fetch failed https://mainnet.helius-rpc.com/?api-key=SECRET_KEY"));
    const { status, body } = await get();
    expect(status).toBe(503);
    expect(body.checks.rpc).toEqual({ status: "fail", reason: "unavailable", slot: null, latencyMs: null });
    expect(JSON.stringify(body)).not.toMatch(/SECRET_KEY|helius/);
  });

  it("reports a misconfigured server RPC (mainnet without a provider) as not configured", async () => {
    m.rpcError = new Error("Server RPC misconfigured: NEXT_PUBLIC_NETWORK is mainnet but no HELIUS_MAINNET_RPC");
    const { status, body } = await get();
    expect(status).toBe(503);
    expect(body.checks.rpc).toMatchObject({ status: "fail", reason: "not_configured" });
    expect(JSON.stringify(body)).not.toContain("HELIUS");
  });

  it("names an RPC on another cluster", async () => {
    m.rpcSend = () => Promise.reject(new NetworkIdentityError("The RPC is connected to a different network. Expected devnet; the blockchain action was stopped."));
    const { body } = await get();
    expect(body.checks.rpc).toMatchObject({ status: "fail", reason: "wrong_network" });
  });

  it("bounds a hanging RPC and database with short timeouts and aborts them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const health = await import("@/lib/server/health");
    m.rpcSend = () => new Promise(() => {}); // ignores its signal, like the genesis check
    m.replies.indexer_jobs = "hang";
    const pending = route.GET();
    await vi.advanceTimersByTimeAsync(Math.max(health.HEALTH_RPC_TIMEOUT_MS, health.HEALTH_DB_TIMEOUT_MS));
    const response = await pending;
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body.checks.rpc).toMatchObject({ status: "fail", reason: "timeout" });
    expect(body.checks.indexerQueue).toMatchObject({ status: "fail", reason: "timeout" });
    expect(body.checks.indexer.status).toBe("ok");
    expect(m.rpcSignal?.aborted).toBe(true);
    expect(m.calls.find((call) => call.table === "indexer_jobs")?.signal?.aborted).toBe(true);
  });

  it("warns on a queue backlog and fails on a stalled queue", async () => {
    m.replies.indexer_jobs = { data: [{ created_at: ago(10 * 60) }], error: null, count: 3 };
    let result = await get();
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.checks.indexerQueue).toEqual({ status: "warn", reason: "backlog", pending: 3, oldestPendingAgeSeconds: 600 });

    vi.setSystemTime(NOW + 60_000); // past the shared-report window
    m.replies.purchase_evidence_jobs = { data: [{ created_at: ago(45 * 60) }], error: null, count: 1 };
    result = await get();
    expect(result.status).toBe(503);
    expect(result.body.checks.purchaseQueue).toEqual({ status: "fail", reason: "stalled", pending: 1, oldestPendingAgeSeconds: 46 * 60 });
  });

  it("keeps a young pending job healthy", async () => {
    m.replies.purchase_evidence_jobs = { data: [{ created_at: ago(20) }], error: null, count: 1 };
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.checks.purchaseQueue).toEqual({ status: "ok", pending: 1, oldestPendingAgeSeconds: 20 });
  });

  it.each([
    ["not initialized", null, { status: "warn", reason: "not_initialized", state: null, fresh: false }],
    ["warming", { status: "warming", last_slot: null, checked_at: ago(5), completed_at: null }, { status: "warn", reason: "warming", state: "warming", fresh: false }],
    ["degraded", { status: "degraded", last_slot: 9, checked_at: ago(5), completed_at: ago(99) }, { status: "warn", reason: "degraded", state: "degraded", lastSlot: 9, fresh: false }],
    ["ready but idle", { status: "ready", last_slot: "77", checked_at: ago(600), completed_at: ago(900) }, { status: "ok", state: "ready", lastSlot: 77, checkedAgeSeconds: 600, fresh: false }],
  ])("reports an indexer that is %s without failing the deployment", async (_label, row, expected) => {
    m.replies.indexer_sync_state = { data: row, error: null };
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.checks.indexer).toMatchObject(expected);
  });

  it("reports maintenance as a warning, not an outage", async () => {
    m.maintenance.mockResolvedValue({ enabled: true, message: "Program upgrade", fresh: true });
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.checks.maintenance).toEqual({ status: "warn", reason: "maintenance", enabled: true });
    expect(JSON.stringify(body)).not.toContain("Program upgrade");
  });

  it("shares one run between concurrent and back-to-back requests for a few seconds", async () => {
    const [a, b] = await Promise.all([get(), get()]);
    expect(a.body).toEqual(b.body);
    await get();
    expect(m.rpcCalls).toBe(1);
    expect(m.calls).toHaveLength(3);
    vi.setSystemTime(NOW + 10_000);
    await get();
    expect(m.rpcCalls).toBe(2);
  });

  it("answers 503 without detail for an invalid network setting", async () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "prod");
    const { status, body } = await get();
    expect(status).toBe(503);
    expect(body).toEqual({ ok: false, error: "Health check unavailable" });
  });

  it("carries no request data or personal fields", async () => {
    const { body } = await get();
    expect(Object.keys(body).sort()).toEqual(["checkedAt", "checks", "commit", "network", "ok"]);
    expect(JSON.stringify(body)).not.toMatch(/wallet|email|signature|buyer|http/i);
  });
});
