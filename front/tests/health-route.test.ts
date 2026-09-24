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
  dbRpc: [] as Call[],
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
/** sb.rpc(name).abortSignal(signal), answered from m.replies[`rpc:${name}`]. */
function rpc(name: string) {
  const call: Call = { table: `rpc:${name}`, filters: [] };
  m.dbRpc.push(call);
  const settle = async () => {
    const reply = m.replies[call.table];
    if (reply === "hang") {
      return new Promise((_resolve, reject) => call.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    if (reply instanceof Error) throw reply;
    return reply;
  };
  const q: Record<string, unknown> = {};
  Object.assign(q, {
    abortSignal: (signal: AbortSignal) => { call.signal = signal; return q; },
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => settle().then(resolve, reject),
  });
  return q;
}
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => {
    if (m.adminError) throw m.adminError;
    return { from, rpc };
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
const TOKEN = "health-token-0123456789abcdef-0123456789";
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
  vi.stubEnv("HEALTH_TOKEN", TOKEN);
  m.calls = [];
  m.dbRpc = [];
  m.adminError = null;
  m.rpcError = null;
  m.rpcCalls = 0;
  m.rpcSignal = null;
  m.rpcSend = () => Promise.resolve(BigInt(412_345_678));
  m.replies = {
    indexer_sync_state: { data: { status: "ready", last_slot: 412_345_000, checked_at: ago(30), completed_at: ago(3600) }, error: null },
    indexer_jobs: { data: [], error: null, count: 0 },
    purchase_evidence_jobs: { data: [], error: null, count: 0 },
    fx_rates: { data: { kind: "rate", as_of: ago(3600), max_age: "7 days" }, error: null },
    "rpc:deployment_network": { data: "devnet", error: null },
  };
  m.maintenance.mockReset();
  m.maintenance.mockResolvedValue({ enabled: false, message: null, fresh: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** The detailed report by default; `authorization: null` asks anonymously. */
async function get(authorization: string | null = `Bearer ${TOKEN}`) {
  const headers = authorization === null ? undefined : { authorization };
  const response = await route.GET(new Request("https://www.manci.io/api/health", { headers }));
  return { status: response.status, headers: response.headers, body: await response.json() };
}

describe("GET /api/health", () => {
  it("answers 200 with every check to the token holder when healthy, never cached", async () => {
    const { status, headers, body } = await get();
    expect(status).toBe(200);
    expect(headers.get("cache-control")).toBe("private, no-store");
    expect(headers.get("vary")).toBe("Authorization");
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
        paymentFx: { status: "ok", kind: "rate", ageSeconds: 3600, maxAgeSeconds: 7 * 86_400 },
        databaseNetwork: { status: "ok", network: "devnet" },
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
    // The network's default payment mint (devnet test USDC).
    expect(byTable.fx_rates.filters).toEqual([["network", "devnet"], ["payment_mint", "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"]]);
    expect(byTable.fx_rates.select).toEqual(["kind,as_of,max_age"]);
    for (const call of [...m.calls, ...m.dbRpc]) expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(m.dbRpc.map((call) => call.table)).toEqual(["rpc:deployment_network"]);
    expect(m.rpcSignal).toBeInstanceOf(AbortSignal);
  });

  describe("payment FX (Talas 4.2 §3.6)", () => {
    const DAY = 86_400;
    const MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const fx = (ageDays: number, maxAge = "7 days", kind = "rate") => ({ data: { kind, as_of: ago(ageDays * DAY), max_age: maxAge }, error: null });

    it.each<[string, Reply, number, Record<string, unknown>]>([
      ["missing", { data: null, error: null }, 503, { status: "fail", reason: "missing", kind: null }],
      ["stale", fx(8), 503, { status: "fail", reason: "stale", kind: "rate", ageSeconds: 8 * DAY, maxAgeSeconds: 7 * DAY }],
      ["at its max age", fx(7), 503, { status: "fail", reason: "stale" }],
      ["at 80 % of its max age", fx(5.6), 200, { status: "warn", reason: "expiring", kind: "rate" }],
      ["fresh", fx(5), 200, { status: "ok", kind: "rate", ageSeconds: 5 * DAY }],
      ["unreadable", { data: null, error: { code: "57014", message: "timeout" } }, 503, { status: "fail", reason: "unavailable" }],
      ["an unparseable max age", fx(1, "soon"), 503, { status: "fail", reason: "invalid" }],
    ])("mainnet: %s", async (_label, reply, status, expected) => {
      vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
      m.replies["rpc:deployment_network"] = { data: "mainnet", error: null };
      m.replies.fx_rates = reply;
      const result = await get();
      expect(result.body.checks.paymentFx).toMatchObject(expected);
      expect(result.status).toBe(status);
      expect(m.calls.find((call) => call.table === "fx_rates")?.filters).toContainEqual(["payment_mint", MAINNET_USDC]);
      expect(JSON.stringify(result.body)).not.toMatch(/57014|timeout"|EPjF/);
    });

    it("mainnet: an anonymous caller sees ok:false (uptime alarms fire)", async () => {
      vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
      m.replies["rpc:deployment_network"] = { data: "mainnet", error: null };
      m.replies.fx_rates = { data: null, error: null };
      const { status, body } = await get(null);
      expect(status).toBe(503);
      expect(body.ok).toBe(false);
    });

    it("an eur_peg row never goes stale", async () => {
      vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
      m.replies["rpc:deployment_network"] = { data: "mainnet", error: null };
      m.replies.fx_rates = fx(400, "7 days", "eur_peg");
      const { status, body } = await get();
      expect(status).toBe(200);
      expect(body.checks.paymentFx).toMatchObject({ status: "ok", kind: "eur_peg", maxAgeSeconds: null });
    });

    it.each<[string, Reply]>([
      ["missing", { data: null, error: null }],
      ["stale", fx(30)],
      ["unreadable", { data: null, error: { code: "x", message: "y" } }],
    ])("devnet: %s only warns", async (_label, reply) => {
      m.replies.fx_rates = reply;
      const { status, body } = await get();
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.checks.paymentFx.status).toBe("warn");
    });

    it("a network without a default payment mint has nothing to check", async () => {
      vi.stubEnv("NEXT_PUBLIC_NETWORK", "localnet");
      const { body } = await get();
      expect(body.checks.paymentFx).toEqual({ status: "ok", kind: null, ageSeconds: null, maxAgeSeconds: null });
      expect(m.calls.find((call) => call.table === "fx_rates")).toBeUndefined();
    });

    it("parses Postgres intervals in both output styles", async () => {
      const { intervalSeconds } = await import("@/lib/server/health");
      expect(intervalSeconds("7 days")).toBe(7 * DAY);
      expect(intervalSeconds("1 day")).toBe(DAY);
      expect(intervalSeconds("1 day 12:00:00")).toBe(DAY + 12 * 3600);
      expect(intervalSeconds("12:30:00")).toBe(12.5 * 3600);
      expect(intervalSeconds("1 mon 2 days")).toBe(32 * DAY);
      expect(intervalSeconds("P7D")).toBe(7 * DAY);
      expect(intervalSeconds("P1DT12H")).toBe(DAY + 12 * 3600);
      for (const bad of ["", "7", "days", "-7 days", "00:00:00", "P", "P1DT", "soon", null, 7]) {
        expect(intervalSeconds(bad)).toBeNull();
      }
    });
  });

  it("reports an unreachable database per check with 503 and without error details", async () => {
    m.replies.indexer_sync_state = new Error("fetch failed: db.secret-host.supabase.co");
    m.replies.indexer_jobs = { data: null, error: { code: "57014", message: "statement timeout on secret-host" }, count: null };
    m.replies.purchase_evidence_jobs = new Error("ECONNREFUSED 10.0.0.7");
    m.maintenance.mockResolvedValue({ enabled: false, message: null, fresh: false });
    m.replies["rpc:deployment_network"] = { data: null, error: { code: "PGRST000", message: "could not connect to secret-host" } };
    const { status, body } = await get();
    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.checks.databaseNetwork).toEqual({ status: "fail", reason: "unavailable", network: null });
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
    for (const check of ["indexer", "indexerQueue", "purchaseQueue", "databaseNetwork"])
      expect(body.checks[check]).toMatchObject({ status: "fail", reason: "not_configured" });
    expect(m.calls).toEqual([]);
    expect(m.dbRpc).toEqual([]);
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
    const pending = route.GET(new Request("https://www.manci.io/api/health", { headers: { authorization: `Bearer ${TOKEN}` } }));
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

  it("warns on a queue backlog and fails on a stalled purchase queue", async () => {
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

  it("only warns about a stalled indexer queue: a poison job stays pending forever and reads fall back to chain", async () => {
    m.replies.indexer_jobs = { data: [{ created_at: ago(3 * 24 * 3600) }], error: null, count: 1 };
    m.replies.indexer_sync_state = { data: { status: "degraded", last_slot: 9, checked_at: ago(5), completed_at: ago(99) }, error: null };
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.checks.indexerQueue).toEqual({ status: "warn", reason: "stalled", pending: 1, oldestPendingAgeSeconds: 3 * 24 * 3600 });
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
    expect(m.calls).toHaveLength(4);
    expect(m.dbRpc).toHaveLength(1);
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

  it("shows anonymous callers only the verdict, cacheable briefly at the edge", async () => {
    m.replies.purchase_evidence_jobs = { data: [{ created_at: ago(20) }], error: null, count: 4 };
    const { status, headers, body } = await get(null);
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, network: "devnet", checkedAt: new Date(NOW).toISOString() });
    expect(headers.get("cache-control")).toBe("public, max-age=0, s-maxage=5");
    expect(headers.get("vary")).toBe("Authorization");
  });

  it("keeps the status code for anonymous callers when a check fails", async () => {
    m.rpcSend = () => Promise.reject(new Error("down"));
    const { status, body } = await get(null);
    expect(status).toBe(503);
    expect(body).toEqual({ ok: false, network: "devnet", checkedAt: new Date(NOW).toISOString() });
  });

  it.each([
    ["a wrong token", `Bearer ${TOKEN}x`, TOKEN],
    ["a non-bearer scheme", `Basic ${TOKEN}`, TOKEN],
    ["no configured token", `Bearer ${TOKEN}`, ""],
    ["a configured token that is too short", "Bearer short-token", "short-token"],
  ])("shows only the verdict for %s", async (_label, authorization, configured) => {
    vi.stubEnv("HEALTH_TOKEN", configured);
    const { body, headers } = await get(authorization);
    expect(Object.keys(body).sort()).toEqual(["checkedAt", "network", "ok"]);
    expect(headers.get("cache-control")).toBe("public, max-age=0, s-maxage=5");
  });

  describe("database network (0070 deployment identity)", () => {
    it.each([
      ["devnet", "devnet", "ok"],
      ["mainnet", "mainnet", "ok"],
      // A testnet front may use the devnet project (asymmetric, like the 0071 guard).
      ["testnet", "devnet", "ok"],
      ["localnet", "testnet", "ok"],
      ["devnet", "mainnet", "fail"],
      ["mainnet", "devnet", "fail"],
      ["mainnet", "testnet", "fail"],
    ] as const)("a %s deployment on a %s database: %s", async (deployment, database, expected) => {
      vi.stubEnv("NEXT_PUBLIC_NETWORK", deployment);
      m.replies["rpc:deployment_network"] = { data: database, error: null };
      const { status, body } = await get();
      expect(body.checks.databaseNetwork).toEqual(
        expected === "ok" ? { status: "ok", network: database } : { status: "fail", reason: "wrong_network", network: database },
      );
      expect(status).toBe(expected === "ok" ? 200 : 503);
      // Anonymous callers see the verdict: ok:true proves the check passed.
      vi.setSystemTime(NOW + 60_000);
      expect((await get(null)).body.ok).toBe(expected === "ok");
    });

    it.each([
      ["the identity row is missing", { code: "55000", message: "Deployment identity is not set" }],
      ["0070 is not applied (PostgREST)", { code: "PGRST202", message: "Could not find the function public.deployment_network" }],
      ["0070 is not applied (PostgreSQL)", { code: "42883", message: "function does not exist" }],
    ])("fails as not configured when %s", async (_label, error) => {
      m.replies["rpc:deployment_network"] = { data: null, error };
      const { status, body } = await get();
      expect(status).toBe(503);
      expect(body.checks.databaseNetwork).toEqual({ status: "fail", reason: "not_configured", network: null });
      expect(JSON.stringify(body)).not.toMatch(/identity is not set|Could not find|does not exist/);
    });

    it("fails on an unexpected value and on a hanging database, without detail", async () => {
      m.replies["rpc:deployment_network"] = { data: "mainnet-beta", error: null };
      expect((await get()).body.checks.databaseNetwork).toEqual({ status: "fail", reason: "unavailable", network: null });
      vi.useFakeTimers();
      vi.setSystemTime(NOW + 60_000);
      const health = await import("@/lib/server/health");
      m.replies["rpc:deployment_network"] = "hang";
      const pending = route.GET(new Request("https://www.manci.io/api/health", { headers: { authorization: `Bearer ${TOKEN}` } }));
      await vi.advanceTimersByTimeAsync(health.HEALTH_DB_TIMEOUT_MS);
      const body = await (await pending).json();
      expect(body.checks.databaseNetwork).toEqual({ status: "fail", reason: "timeout", network: null });
      expect(m.dbRpc.at(-1)?.signal?.aborted).toBe(true);
    });

    it("shares the D8 rule with the guard", async () => {
      const { databaseNetworkMatches } = await import("@/lib/server/health");
      expect(databaseNetworkMatches("devnet", "testnet")).toBe(true);
      expect(databaseNetworkMatches("mainnet", "mainnet")).toBe(true);
      expect(databaseNetworkMatches("mainnet", "devnet")).toBe(false);
      expect(databaseNetworkMatches("devnet", "mainnet")).toBe(false);
    });
  });
});
