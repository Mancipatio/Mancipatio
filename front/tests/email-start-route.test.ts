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
  EMAIL_START_BODY_LIMIT, GLOBAL_LOGIN_EMAIL_LIMIT, GLOBAL_LOGIN_EMAIL_WINDOW_SECONDS,
} from "@/lib/server/auth-login";
import { TURNSTILE_ACTIONS } from "@/lib/turnstile";
import { SiwsError } from "@/lib/server/siws-error";

const ORIGIN = "https://www.manci.test";

async function call(body: unknown) {
  const res = await POST(new Request(`${ORIGIN}/api/auth/email/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, "x-real-ip": "203.0.113.9" },
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
  it("checks Turnstile first, then the per-IP, per-address and all-address caps, then sends", async () => {
    const { status, json } = await call({ email: "Ana@Example.com", turnstile_token: "tok" });
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, data: { sent: true } });
    expect(m.turnstile).toHaveBeenCalledWith(expect.any(Request), "tok", TURNSTILE_ACTIONS.emailLogin);
    expect(m.steps).toEqual([
      "turnstile",
      "limit:login-ip:203.0.113.9",
      "limit:login-email:devnet:ana@example.com",
      "limit:login-email-all:devnet",
      "insert",
      "send",
    ]);
    expect(m.limits.at(-1)).toEqual({ key: "login-email-all:devnet", limit: GLOBAL_LOGIN_EMAIL_LIMIT, window: GLOBAL_LOGIN_EMAIL_WINDOW_SECONDS });
  });

  it("keeps the all-address cap inside the DB limiter's bounds and on a short window", () => {
    expect(GLOBAL_LOGIN_EMAIL_LIMIT).toBeGreaterThanOrEqual(1);
    expect(GLOBAL_LOGIN_EMAIL_LIMIT).toBeLessThanOrEqual(100);
    expect(GLOBAL_LOGIN_EMAIL_WINDOW_SECONDS).toBeGreaterThanOrEqual(60);
    expect(GLOBAL_LOGIN_EMAIL_WINDOW_SECONDS).toBeLessThanOrEqual(3600);
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

  it("answers 429 and sends nothing when the all-address cap is reached", async () => {
    m.refuseLimit = "login-email-all:";
    const { status } = await call({ email: "ana@example.com", turnstile_token: "tok" });
    expect(status).toBe(429);
    expect(m.steps).not.toContain("insert");
    expect(m.steps).not.toContain("send");
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
