import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({
  steps: [] as string[],
  limits: [] as { key: string; limit: number; window: number }[],
  inserts: [] as unknown[],
  turnstile: vi.fn(),
  refuseLimit: null as string | null,
}));
vi.mock("@/lib/server/turnstile", () => ({
  verifyTurnstile: async (...args: unknown[]) => { m.steps.push("turnstile"); return m.turnstile(...args); },
}));
vi.mock("@/lib/server/account-profile", async () => {
  const { SiwsError } = await import("@/lib/server/siws-error");
  return {
    consumeAccountRateLimit: async (key: string, limit: number, window: number) => {
      m.steps.push(`limit:${key}`);
      m.limits.push({ key, limit, window });
      if (m.refuseLimit && key.startsWith(m.refuseLimit)) throw new SiwsError(429, "Too many requests. Please try again later.");
    },
  };
});
vi.mock("@/lib/server/email", () => ({
  emailConfigured: () => true,
  escapeHtml: (value: string) => value,
  sendEmail: vi.fn(async () => { m.steps.push("send"); return { sent: true }; }),
}));
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    from: () => ({ insert: async (row: unknown) => { m.steps.push("insert"); m.inserts.push(row); return { error: null }; } }),
  }),
}));

import { POST } from "@/app/api/auth/email/start/route";
import {
  EMAIL_START_BODY_LIMIT, EMAIL_START_BURST_LIMIT, EMAIL_START_BURST_WINDOW_MS, GLOBAL_LOGIN_EMAIL_LIMIT,
  GLOBAL_LOGIN_EMAIL_WINDOW_SECONDS, LOGIN_EMAIL_LIMIT, LOGIN_IP_LIMIT,
} from "@/lib/server/auth-login";
import { TURNSTILE_ACTIONS } from "@/lib/turnstile";
import { SiwsError } from "@/lib/server/siws-error";
import { ipRateLimitKey } from "@/app/api/clients/_helpers";

const ORIGIN = "https://www.manci.test";

// A fresh client IP per call keeps the in-memory burst cap (per instance, so
// shared by every test in this file) out of the way unless a test pins one.
let ipCounter = 0;
const freshIp = () => `203.0.113.${++ipCounter}`;

async function call(body: unknown, ip = freshIp()) {
  const res = await POST(new Request(`${ORIGIN}/api/auth/email/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, "x-real-ip": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", ORIGIN);
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  m.steps.length = 0;
  m.limits.length = 0;
  m.inserts.length = 0;
  m.refuseLimit = null;
  m.turnstile.mockReset().mockResolvedValue(undefined);
});

describe("/api/auth/email/start", () => {
  it("checks Turnstile first, then the per-IP, all-address and per-address caps, then sends", async () => {
    const { status, json } = await call({ email: "Ana@Example.com", turnstile_token: "tok" }, "203.0.113.200");
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, data: { sent: true } });
    expect(m.turnstile).toHaveBeenCalledWith(expect.any(Request), "tok", TURNSTILE_ACTIONS.emailLogin);
    expect(m.steps).toEqual([
      "turnstile",
      "limit:login-ip:203.0.113.200",
      "limit:login-email-all:devnet",
      "limit:login-email:devnet:ana@example.com",
      "insert",
      "send",
    ]);
    expect(m.limits).toEqual([
      { key: "login-ip:203.0.113.200", limit: LOGIN_IP_LIMIT, window: 3600 },
      { key: "login-email-all:devnet", limit: GLOBAL_LOGIN_EMAIL_LIMIT, window: GLOBAL_LOGIN_EMAIL_WINDOW_SECONDS },
      { key: "login-email:devnet:ana@example.com", limit: LOGIN_EMAIL_LIMIT, window: 3600 },
    ]);
  });

  it("keeps the all-address cap a high circuit breaker inside the DB limiter's bounds", () => {
    expect(GLOBAL_LOGIN_EMAIL_LIMIT).toBeGreaterThanOrEqual(1);
    expect(GLOBAL_LOGIN_EMAIL_LIMIT).toBeLessThanOrEqual(100);
    expect(GLOBAL_LOGIN_EMAIL_WINDOW_SECONDS).toBeGreaterThanOrEqual(1);
    expect(GLOBAL_LOGIN_EMAIL_WINDOW_SECONDS).toBeLessThanOrEqual(86_400);
    // A handful of IPs at the per-IP cap must not be able to fill it: it
    // takes at least 5 IPs' whole hourly allowance inside one window.
    expect(GLOBAL_LOGIN_EMAIL_LIMIT / LOGIN_IP_LIMIT).toBeGreaterThanOrEqual(5);
    expect(GLOBAL_LOGIN_EMAIL_WINDOW_SECONDS).toBeLessThanOrEqual(60);
  });

  it("keys the per-IP cap on the /64 prefix for IPv6 clients", async () => {
    expect((await call({ email: "ana@example.com" }, "2001:db8:1:2:aaaa:bbbb:cccc:dddd")).status).toBe(200);
    expect((await call({ email: "ana@example.com" }, "2001:DB8:1:2::9")).status).toBe(200);
    const ipKeys = m.limits.filter((limit) => limit.key.startsWith("login-ip:")).map((limit) => limit.key);
    expect(ipKeys).toEqual(["login-ip:2001:db8:1:2::/64", "login-ip:2001:db8:1:2::/64"]);
  });

  it("caps bursts per IP in memory before calling Turnstile or the DB caps", async () => {
    const ip = "198.51.100.77";
    for (let i = 0; i < EMAIL_START_BURST_LIMIT; i++) {
      expect((await call({ email: `u${i}@example.com`, turnstile_token: "tok" }, ip)).status).toBe(200);
    }
    m.steps.length = 0;
    m.turnstile.mockClear();
    const { status, json } = await call({ email: "late@example.com", turnstile_token: "junk" }, ip);
    expect(status).toBe(429);
    expect(json.error).toMatch(/try again in a minute/);
    expect(m.turnstile).not.toHaveBeenCalled();
    expect(m.steps).toEqual([]);
    // Another /64 or IP is unaffected.
    expect((await call({ email: "ana@example.com", turnstile_token: "tok" })).status).toBe(200);
    expect(EMAIL_START_BURST_LIMIT).toBeGreaterThan(LOGIN_EMAIL_LIMIT);
    expect(EMAIL_START_BURST_WINDOW_MS).toBeLessThanOrEqual(60_000);
  });

  it("passes an absent token through (Turnstile off is decided by the verifier)", async () => {
    expect((await call({ email: "ana@example.com" })).status).toBe(200);
    expect(m.turnstile).toHaveBeenCalledWith(expect.any(Request), undefined, TURNSTILE_ACTIONS.emailLogin);
  });

  it("refuses a failed challenge before any cap is used or mail is sent", async () => {
    m.turnstile.mockRejectedValue(new SiwsError(403, "The security check failed. Please try again."));
    const { status, json } = await call({ email: "ana@example.com", turnstile_token: "bad" });
    expect(status).toBe(403);
    expect(json.error).toMatch(/security check/);
    expect(m.steps).toEqual(["turnstile"]);
  });

  it("validates the address before calling Turnstile", async () => {
    expect((await call({ email: "not-an-address", turnstile_token: "tok" })).status).toBe(400);
    expect(m.turnstile).not.toHaveBeenCalled();
  });

  it("does not log when another cap refuses (runs before any global-cap log)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      m.refuseLimit = "login-email:";
      expect((await call({ email: "ana@example.com", turnstile_token: "tok" })).status).toBe(429);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("answers 429, sends nothing and logs (without PII) when the all-address cap is reached", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      m.refuseLimit = "login-email-all:";
      const { status } = await call({ email: "ana@example.com", turnstile_token: "tok" }, "203.0.113.201");
      expect(status).toBe(429);
      expect(m.steps).not.toContain("insert");
      expect(m.steps).not.toContain("send");
      // The per-address cap is not touched, so a real user retrying during a
      // trip keeps their own sends.
      expect(m.steps).not.toContain("limit:login-email:devnet:ana@example.com");
      // Logged at most once a minute per instance.
      await call({ email: "bo@example.com", turnstile_token: "tok" });
      expect(warn).toHaveBeenCalledOnce();
      const line = String(warn.mock.calls[0][0]);
      expect(line).toMatch(/deployment-wide sign-in email cap reached on devnet/);
      expect(line).not.toMatch(/ana@example\.com|bo@example\.com|203\.0\.113/);
    } finally {
      warn.mockRestore();
    }
  });

  it("accepts a maximum-length Turnstile token with a maximum-length address", async () => {
    const email = `${"a".repeat(64)}@${"b".repeat(185)}.com`;
    expect(email.length).toBe(254);
    const body = JSON.stringify({ email, turnstile_token: "t".repeat(2048) });
    expect(body.length).toBeLessThanOrEqual(EMAIL_START_BODY_LIMIT);
    expect((await call(body)).status).toBe(200);
  });

  it("still refuses bodies over the cap", async () => {
    const { status } = await call({ email: "ana@example.com", turnstile_token: "t".repeat(EMAIL_START_BODY_LIMIT) });
    expect(status).toBe(413);
    expect(m.steps).toEqual([]);
  });

  it("refuses cross-site posts", async () => {
    const res = await POST(new Request(`${ORIGIN}/api/auth/email/start`, {
      method: "POST", headers: { Origin: "https://evil.example" }, body: JSON.stringify({ email: "ana@example.com" }),
    }));
    expect(res.status).toBe(403);
    expect(m.steps).toEqual([]);
  });
});

describe("ipRateLimitKey", () => {
  it.each([
    ["203.0.113.9", "203.0.113.9"],
    ["unknown", "unknown"],
    ["2001:db8:1:2:aaaa:bbbb:cccc:dddd", "2001:db8:1:2::/64"],
    ["2001:DB8:1:2::9", "2001:db8:1:2::/64"],
    ["2001:0db8:0000:0002::1", "2001:db8:0:2::/64"],
    ["[2001:db8::1]", "2001:db8:0:0::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    // IPv4-mapped IPv6 is the IPv4 client.
    ["::ffff:198.51.100.7", "198.51.100.7"],
    ["::ffff:c633:6407", "198.51.100.7"],
    // Unparseable input is kept as is.
    ["not:an:address", "not:an:address"],
  ])("%s → %s", (ip, key) => {
    expect(ipRateLimitKey(ip)).toBe(key);
  });

  it("gives every address in one /64 the same bucket and different /64s different ones", () => {
    expect(ipRateLimitKey("2001:db8:1:2::1")).toBe(ipRateLimitKey("2001:db8:1:2:ffff:ffff:ffff:ffff"));
    expect(ipRateLimitKey("2001:db8:1:2::1")).not.toBe(ipRateLimitKey("2001:db8:1:3::1"));
  });
});
