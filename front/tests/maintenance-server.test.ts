import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({
  reads: 0,
  filters: [] as unknown[][],
  reply: { data: null, error: null } as { data: unknown; error: unknown } | Error,
  gate: null as Promise<void> | null,
}));
function from(table: string) {
  expect(table).toBe("platform_maintenance");
  const q: Record<string, unknown> = {};
  Object.assign(q, {
    select: () => q,
    eq: (...args: unknown[]) => { m.filters.push(args); return q; },
    abortSignal: (signal: unknown) => { expect(signal).toBeInstanceOf(AbortSignal); return q; },
    maybeSingle: async () => {
      m.reads++;
      if (m.gate) await m.gate;
      if (m.reply instanceof Error) throw m.reply;
      return m.reply;
    },
  });
  return q;
}
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({ from }) }));

type Server = typeof import("@/lib/server/maintenance");
let server: Server;
beforeEach(async () => {
  // Fresh module state (cache, warn-once) for every test.
  vi.resetModules();
  server = await import("@/lib/server/maintenance");
  m.reads = 0; m.filters = []; m.gate = null;
  m.reply = { data: null, error: null };
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-23T10:00:00Z"));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("maintenance flag", () => {
  it("reads the network's row and treats a missing row as off", async () => {
    await expect(server.getMaintenance("devnet")).resolves.toEqual({ enabled: false, message: null });
    expect(m.filters).toEqual([["network", "devnet"]]);
  });

  it("returns the operator message, or a default one, while enabled", async () => {
    m.reply = { data: { enabled: true, message: "  Program upgrade, back at 14:00.  " }, error: null };
    await expect(server.getMaintenance("devnet")).resolves.toEqual({ enabled: true, message: "Program upgrade, back at 14:00." });
    vi.setSystemTime(Date.now() + 6_000);
    m.reply = { data: { enabled: true, message: null }, error: null };
    const { message } = await server.getMaintenance("devnet");
    expect(message).toMatch(/upgrade in progress/);
  });

  it("treats a missing table (migration 0061 not applied) as a definite off", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const code of ["42P01", "PGRST205"]) {
      vi.resetModules();
      server = await import("@/lib/server/maintenance");
      m.reply = { data: null, error: { code, message: "relation does not exist" } };
      await expect(server.readMaintenance("devnet")).resolves.toEqual({ enabled: false, message: null, fresh: true });
    }
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/relation does not exist/);
  });

  it.each([
    ["a PostgREST error", { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }],
    ["a thrown network error", new Error("fetch failed: secret-host")],
  ])("fails open on %s when the flag was never read, and warns once per outage without details", async (_label, reply) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    m.reply = reply;
    await expect(server.readMaintenance("devnet")).resolves.toEqual({ enabled: false, message: null, fresh: false });
    vi.setSystemTime(Date.now() + 6_000);
    await expect(server.getMaintenance("devnet")).resolves.toEqual({ enabled: false, message: null });
    await expect(server.assertWritable("devnet")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret-host|statement timeout/);
    // Recovery resets the warning, so the next outage is reported again.
    m.reply = { data: null, error: null };
    vi.setSystemTime(Date.now() + 6_000);
    await server.getMaintenance("devnet");
    m.reply = reply;
    vi.setSystemTime(Date.now() + 6_000);
    await server.getMaintenance("devnet");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("keeps maintenance on through failed reads until a read succeeds", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    m.reply = { data: { enabled: true, message: "Upgrade" }, error: null };
    await server.getMaintenance("devnet");
    // The database is slow or restarting mid-maintenance.
    m.reply = new Error("timeout");
    vi.setSystemTime(Date.now() + 6_000);
    await expect(server.readMaintenance("devnet")).resolves.toEqual({ enabled: true, message: "Upgrade", fresh: false });
    await expect(server.assertWritable("devnet")).rejects.toBeInstanceOf(server.MaintenanceError);
    // A failed read is retried after a second, not cached for the full window.
    const reads = m.reads;
    vi.setSystemTime(Date.now() + 500);
    await server.getMaintenance("devnet");
    expect(m.reads).toBe(reads);
    vi.setSystemTime(Date.now() + 600);
    await expect(server.getMaintenance("devnet")).resolves.toMatchObject({ enabled: true });
    expect(m.reads).toBe(reads + 1);
    // Only a successful read switches it off.
    m.reply = { data: { enabled: false, message: null }, error: null };
    vi.setSystemTime(Date.now() + 1_100);
    await expect(server.readMaintenance("devnet")).resolves.toEqual({ enabled: false, message: null, fresh: true });
    await expect(server.assertWritable("devnet")).resolves.toBeUndefined();
  });

  it("caches per network for about five seconds and coalesces concurrent reads", async () => {
    m.reply = { data: { enabled: true, message: "Upgrade" }, error: null };
    let open!: () => void;
    m.gate = new Promise((resolve) => { open = resolve; });
    const concurrent = Promise.all([server.getMaintenance("devnet"), server.getMaintenance("devnet")]);
    open();
    await concurrent;
    expect(m.reads).toBe(1);
    m.gate = null;
    m.reply = { data: null, error: null };
    vi.setSystemTime(Date.now() + 4_000);
    await expect(server.getMaintenance("devnet")).resolves.toMatchObject({ enabled: true });
    expect(m.reads).toBe(1);
    await server.getMaintenance("mainnet");
    expect(m.reads).toBe(2);
    vi.setSystemTime(Date.now() + 1_500);
    await expect(server.getMaintenance("devnet")).resolves.toMatchObject({ enabled: false });
    expect(m.reads).toBe(3);
  });

  it("refuses with a 503 SiwsError carrying the message", async () => {
    m.reply = { data: { enabled: true, message: "Upgrade" }, error: null };
    const { SiwsError } = await import("@/lib/server/siws");
    const error = await server.assertWritable("devnet").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(server.MaintenanceError);
    expect(error).toBeInstanceOf(SiwsError);
    expect(error).toMatchObject({ status: 503, message: "Manci is in maintenance: Upgrade", maintenanceMessage: "Upgrade" });
  });

  it("classifies reads, sign-in, ToS acceptance, indexer repairs and receipts as allowed, everything else as refused", () => {
    for (const action of ["clients.me", "account.me", "applications.mine", "auth.session", "tos.accept", "admin.reconcile", "admin.retryIndexer", "admin.reconcilePurchases"]) {
      expect(server.refusedInMaintenance(action)).toBe(false);
    }
    // Receipts of transactions that already landed are recorded, never lost.
    for (const action of ["launchpad.recordPurchase", "vesting-series.record-step", "conversion.deposited", "conversion.reclaim", "delivery.deposited", "delivery.reclaim"]) {
      expect(server.refusedInMaintenance(action)).toBe(false);
    }
    for (const action of ["account.wallets.transaction", "clients.create", "launchpad.commit", "clients.passport-sync", "account.update", "verification.submit", "unknown.action"]) {
      expect(server.refusedInMaintenance(action)).toBe(true);
    }
  });

  it("does not read the flag for allowed actions", async () => {
    await server.assertActionWritable("clients.me", "devnet");
    expect(m.reads).toBe(0);
    await server.assertActionWritable("clients.create", "devnet");
    expect(m.reads).toBe(1);
  });
});

describe("maintenance responses", () => {
  const body = { ok: false, error: "Manci is in maintenance: Upgrade", code: "maintenance", message: "Upgrade" };

  it("maps through siwsErrorResponse and accountErrorResponse as 503 no-store JSON", async () => {
    const { siwsErrorResponse } = await import("@/lib/server/siws");
    const { accountErrorResponse } = await import("@/lib/server/account-profile");
    for (const map of [siwsErrorResponse, accountErrorResponse]) {
      const res = map(new server.MaintenanceError("Upgrade"));
      expect(res.status).toBe(503);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("Retry-After")).toBe("60");
      await expect(res.json()).resolves.toEqual(body);
    }
  });

  it("GET /api/maintenance reports the deployment network, shareable by the CDN for a few seconds only", async () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
    const { GET } = await import("@/app/api/maintenance/route");
    let res = await GET();
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=0, s-maxage=5, stale-while-revalidate=5");
    await expect(res.json()).resolves.toEqual({ enabled: false, message: null, network: "devnet" });
    m.reply = { data: { enabled: true, message: "Upgrade" }, error: null };
    vi.setSystemTime(Date.now() + 6_000);
    res = await GET();
    await expect(res.json()).resolves.toEqual({ enabled: true, message: "Upgrade", network: "devnet" });
    expect(m.filters.at(-1)).toEqual(["network", "devnet"]);
  });

  it("GET /api/maintenance answers 503 uncached when the flag cannot be read, instead of 'off'", async () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { GET } = await import("@/app/api/maintenance/route");
    m.reply = { data: { enabled: true, message: "Upgrade" }, error: null };
    expect((await GET()).status).toBe(200);
    m.reply = new Error("database down");
    vi.setSystemTime(Date.now() + 6_000);
    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ ok: false });
    expect(body).not.toHaveProperty("enabled");
  });
});
