// front-app-15: POST /api/audit is bounded — same origin only, a body cap, a
// per-instance burst cap and a per-IP limit shared by every instance
// (consume_account_rate_limit, 0052) — and a wallet session for the same
// wallet verifies the row. Supabase is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const db = vi.hoisted(() => ({
  limit: "ok" as "ok" | "limited" | "down",
  rpcs: [] as { fn: string; args: Record<string, unknown> }[],
  inserts: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/network", async (orig) => ({ ...(await orig<typeof import("@/lib/network")>()), detectNetwork: () => "devnet" }));
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      db.rpcs.push({ fn, args });
      return { abortSignal: () => Promise.resolve(db.limit === "down"
        ? { data: null, error: { code: "08006" } } : { data: db.limit === "ok", error: null }) };
    },
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        db.inserts.push(row);
        return { select: () => ({ single: () => Promise.resolve({ data: { id: "row-1" }, error: null }) }) };
      },
    }),
  }),
}));

import { POST } from "@/app/api/audit/route";
import { consumeSharedRateLimit } from "@/lib/server/shared-rate-limit";
import { issueSessionToken } from "@/lib/server/siws-session";
import { SESSION_COOKIE } from "@/lib/siws-session";

const SITE = "https://www.manci.test";
const WALLET = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
let ip = 0;
const event = { ix_name: "open_sale", category: "launchpad", actor_wallet: WALLET, reason: "" };
const post = (opts: { body?: string; origin?: string | null; cookie?: string; ip?: string } = {}) => {
  const headers: Record<string, string> = { "x-real-ip": opts.ip ?? `203.0.113.${++ip % 250}` };
  if (opts.origin !== null) headers.origin = opts.origin ?? SITE;
  if (opts.cookie) headers.cookie = opts.cookie;
  return POST(new Request(`${SITE}/api/audit`, { method: "POST", headers, body: opts.body ?? JSON.stringify(event) }));
};

beforeEach(() => {
  db.limit = "ok";
  db.rpcs = [];
  db.inserts = [];
  vi.stubEnv("SESSION_SECRET", "s".repeat(40));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/audit guards", () => {
  it("writes an unverified row from the site's own origin, through the shared limiter", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(db.rpcs).toEqual([{ fn: "consume_account_rate_limit", args: expect.objectContaining({ p_limit: 100, p_window_seconds: 600 }) }]);
    expect(String(db.rpcs[0].args.p_key_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(db.inserts[0].metadata).toMatchObject({ actor_verified: false, actor_source: "client-unsigned" });
  });

  it("refuses a missing or foreign Origin (403) before reading anything", async () => {
    expect((await post({ origin: null })).status).toBe(403);
    expect((await post({ origin: "https://evil.example" })).status).toBe(403);
    expect(db.rpcs).toEqual([]);
    expect(db.inserts).toEqual([]);
  });

  it("refuses a body over 32 KiB (413)", async () => {
    const res = await post({ body: JSON.stringify({ ...event, metadata: { blob: "x".repeat(40_000) } }) });
    expect(res.status).toBe(413);
    expect(db.inserts).toEqual([]);
  });

  it("429 when the shared per-IP limit is spent; the per-instance burst cap stops a flood first", async () => {
    db.limit = "limited";
    expect((await post()).status).toBe(429);
    expect(db.inserts).toEqual([]);
    db.limit = "ok";
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await post({ ip: "198.51.100.7" })).status);
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it("a limiter the database cannot answer does not drop the breadcrumb (the per-instance cap still applies)", async () => {
    db.limit = "down";
    expect((await post()).status).toBe(200);
    expect(db.inserts).toHaveLength(1);
  });

  it("a wallet session for the same wallet, network and origin verifies the row; another wallet's does not", async () => {
    const mine = issueSessionToken(WALLET, "devnet", SITE)!.token;
    await post({ cookie: `${SESSION_COOKIE}=${mine}` });
    expect(db.inserts.at(-1)!.metadata).toMatchObject({ actor_verified: true, actor_source: "siws-session" });
    const other = issueSessionToken("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", "devnet", SITE)!.token;
    await post({ cookie: `${SESSION_COOKIE}=${other}` });
    expect(db.inserts.at(-1)!.metadata).toMatchObject({ actor_verified: false, actor_source: "client-unsigned" });
    const elsewhere = issueSessionToken(WALLET, "devnet", "https://other.manci.test")!.token;
    await post({ cookie: `${SESSION_COOKIE}=${elsewhere}` });
    expect(db.inserts.at(-1)!.metadata).toMatchObject({ actor_verified: false });
  });
});

describe("consumeSharedRateLimit", () => {
  it("ok / limited / unavailable, never throwing on a database error; refuses limits the SQL would reject", async () => {
    expect(await consumeSharedRateLimit("k", 5, 60)).toBe("ok");
    db.limit = "limited";
    expect(await consumeSharedRateLimit("k", 5, 60)).toBe("limited");
    db.limit = "down";
    expect(await consumeSharedRateLimit("k", 5, 60)).toBe("unavailable");
    await expect(consumeSharedRateLimit("k", 101, 60)).rejects.toThrow();
    await expect(consumeSharedRateLimit("k", 5, 86_401)).rejects.toThrow();
    // The key never leaves the process in clear.
    expect(JSON.stringify(db.rpcs)).not.toContain('"k"');
  });
});
