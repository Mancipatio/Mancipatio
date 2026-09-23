import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ turnstile: vi.fn(), inserts: [] as unknown[] }));
vi.mock("@/lib/server/turnstile", () => ({ verifyTurnstile: m.turnstile }));
vi.mock("@/lib/server/email", () => ({ sendEmail: vi.fn(async () => ({ sent: true })) }));
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    from: () => ({
      insert: (row: unknown) => {
        m.inserts.push(row);
        return { select: () => ({ single: async () => ({ data: { id: "inq-1" }, error: null }) }) };
      },
    }),
  }),
}));

import { POST } from "@/app/api/inquiries/create/route";
import { SiwsError } from "@/lib/server/siws-error";
import { TURNSTILE_ACTIONS } from "@/lib/turnstile";

let ip = 0;
async function call(body: Record<string, unknown> | string) {
  // A fresh IP per call keeps the in-memory 5/min limiter out of the way.
  ip += 1;
  const res = await POST(new Request("https://www.manci.test/api/inquiries/create", {
    method: "POST", headers: { "Content-Type": "application/json", "x-real-ip": `198.51.100.${ip}` },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
  return { status: res.status, json: await res.json() };
}

const valid = { name: "Ana", email: "ana@example.com", idea: "Tokenize a vineyard's annual harvest revenue." };

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  m.inserts.length = 0;
  m.turnstile.mockReset().mockResolvedValue(undefined);
});

describe("/api/inquiries/create — Turnstile", () => {
  it("verifies the token for the inquiry action before saving", async () => {
    const { status, json } = await call({ ...valid, turnstile_token: "tok" });
    expect(status).toBe(200);
    expect(json.data.id).toBe("inq-1");
    expect(m.turnstile).toHaveBeenCalledWith(expect.any(Request), "tok", TURNSTILE_ACTIONS.inquiry);
    expect(m.inserts).toHaveLength(1);
    expect(m.inserts[0]).not.toHaveProperty("turnstile_token");
  });

  it("saves nothing when the check fails", async () => {
    m.turnstile.mockRejectedValue(new SiwsError(403, "The security check failed. Please try again."));
    expect((await call({ ...valid, turnstile_token: "bad" })).status).toBe(403);
    expect(m.inserts).toHaveLength(0);
  });

  it("refuses invalid fields without calling Cloudflare", async () => {
    expect((await call({ ...valid, idea: "too short", turnstile_token: "tok" })).status).toBe(400);
    expect(m.turnstile).not.toHaveBeenCalled();
  });

  it("keeps the honeypot answer unchanged (fake success, nothing saved, no check)", async () => {
    const { status } = await call({ ...valid, website: "https://spam.example" });
    expect(status).toBe(200);
    expect(m.turnstile).not.toHaveBeenCalled();
    expect(m.inserts).toHaveLength(0);
  });
});

describe("/api/inquiries/create — body cap", () => {
  it("refuses an oversized body with 413 before parsing it", async () => {
    const { status, json } = await call({ ...valid, idea: "x".repeat(40_000), turnstile_token: "tok" });
    expect(status).toBe(413);
    expect(json.error).toMatch(/too large/);
    expect(m.turnstile).not.toHaveBeenCalled();
    expect(m.inserts).toHaveLength(0);
  });

  it("still accepts the largest valid submission (5000 three-byte characters and a full token)", async () => {
    const body = JSON.stringify({
      name: "名".repeat(200), company: "社".repeat(200), asset_kind: "種".repeat(120),
      email: "ana@example.com", idea: "葡".repeat(5000), turnstile_token: "t".repeat(2048),
    });
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(16 * 1024);
    expect((await call(body)).status).toBe(200);
    expect(m.inserts).toHaveLength(1);
  });

  it("answers 400 for a body that is not JSON", async () => {
    expect((await call("{not json")).status).toBe(400);
    expect(m.inserts).toHaveLength(0);
  });
});
