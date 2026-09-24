// Talas 4.4b: GET /api/health/alarms (dead-man switch) and the compliance
// list ordering (an old open critical alert stays visible).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const s = vi.hoisted(() => ({
  network: "devnet", beat: null as string | null, pending: 0, failed: 0, dbNetwork: "devnet" as string | null,
  alerts: { open: [] as unknown[], other: [] as unknown[] },
}));
vi.mock("@/lib/network", async (orig) => ({ ...(await orig<typeof import("@/lib/network")>()), detectNetwork: () => s.network }));
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => ({}) }));
vi.mock("@/lib/server/maintenance", () => ({ readMaintenance: async () => ({ enabled: false, fresh: true }) }));
vi.mock("@/lib/server/siws", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/siws")>()),
  verifySigned: vi.fn(async () => ({ wallet: "admin", params: {}, via: "session" })),
}));
vi.mock("@/lib/server/admin-gate", () => ({ requireAdmin: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    rpc: () => ({ abortSignal: () => Promise.resolve(s.dbNetwork ? { data: s.dbNetwork, error: null } : { data: null, error: { code: "55000" } }) }),
    from: (table: string) => {
      const f: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      for (const k of ["select", "order", "limit", "is", "or"]) b[k] = () => b;
      b.eq = (c: string, v: unknown) => { f[c] = v; return b; };
      b.in = (c: string, v: unknown) => { f[`in:${c}`] = v; return b; };
      b.not = () => { f.not = true; return b; };
      b.maybeSingle = () => ({ abortSignal: () => Promise.resolve({ data: s.beat ? { last_ok_at: s.beat } : null, error: null }) });
      const result = () => {
        if (table === "compliance_alerts" && f.notify_state === "pending") return { count: s.pending, error: null };
        if (table === "compliance_alerts" && f.notify_state === "failed") return { count: s.failed, error: null };
        if (table === "compliance_alerts") return { data: f.not ? s.alerts.other : s.alerts.open, error: null };
        return { data: null, error: null };
      };
      const beat = () => Promise.resolve({ data: s.beat ? { last_ok_at: s.beat } : null, error: null });
      b.abortSignal = () => Object.assign(Promise.resolve(result()), { maybeSingle: beat });
      b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve);
      return b;
    },
  }),
}));
import { GET } from "@/app/api/health/alarms/route";
import { POST as listRoute } from "@/app/api/compliance/list/route";
import { resetAlarmHealthCache } from "@/lib/server/alarm-health";

beforeEach(() => {
  resetAlarmHealthCache();
  Object.assign(s, { network: "devnet", beat: new Date().toISOString(), pending: 0, failed: 0, dbNetwork: "devnet" });
  vi.stubEnv("COMPLIANCE_ALERT_EMAIL", "office@mancipatio.io");
  vi.stubEnv("SMTP_HOST", "smtp.test"); vi.stubEnv("SMTP_USER", "u"); vi.stubEnv("SMTP_PASS", "p"); vi.stubEnv("EMAIL_FROM", "a@x.io");
});
afterEach(() => vi.unstubAllEnvs());
const get = async () => { resetAlarmHealthCache(); const r = await GET(); return { status: r.status, body: await r.json() }; };

describe("GET /api/health/alarms", () => {
  it("200 with only {ok, network, checkedAt} when the alarm worker is fresh and nothing is stuck", async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["checkedAt", "network", "ok"]);
  });

  it("503 after a failed notification on an open alert, until it is resolved or re-queued", async () => {
    s.failed = 1;
    expect((await get()).status).toBe(503);
    s.failed = 0;
    expect((await get()).status).toBe(200);
  });

  it("503 on a stale alarm heartbeat, a stuck pending notification, or a database of another network", async () => {
    s.beat = new Date(Date.now() - 6 * 60_000).toISOString();
    expect((await get()).status).toBe(503);
    s.beat = new Date().toISOString(); s.pending = 1;
    expect((await get()).status).toBe(503);
    s.pending = 0; s.dbNetwork = "mainnet";
    expect((await get()).status).toBe(503);
  });

  it("unconfigured email is tolerated off mainnet only", async () => {
    vi.stubEnv("COMPLIANCE_ALERT_EMAIL", "");
    s.pending = 5;
    expect((await get()).status).toBe(200);
    s.network = "mainnet"; s.dbNetwork = "mainnet";
    expect((await get()).status).toBe(503);
  });
});

describe("POST /api/compliance/list", () => {
  it("an old open critical alert stays visible behind 500 newer low rows; open first, then severity, then newest", async () => {
    const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    s.alerts.open = [
      { id: "old-critical", status: "open", severity: "critical", created_at: at(60 * 24 * 90) },
      { id: "new-medium", status: "escalated", severity: "medium", created_at: at(1) },
    ];
    s.alerts.other = Array.from({ length: 200 }, (_, i) => ({ id: `low-${i}`, status: "resolved", severity: "low", created_at: at(i) }));
    const response = await listRoute(new Request("http://localhost/api/compliance/list", { method: "POST", body: "{}" }));
    const body = await response.json();
    expect(body.data.alerts.slice(0, 3).map((a: { id: string }) => a.id)).toEqual(["old-critical", "new-medium", "low-0"]);
    expect(body.data.truncated).toEqual({ open: false, other: true });
  });
});
