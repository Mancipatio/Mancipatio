// front-app-15: /api/passport/submit counts across every instance per wallet
// AND per IP (wallets cost nothing to make). Both limiters are mocked; the
// route stops before any database work when either is spent.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const WALLET = "7xGLjBL7VWYNmBZxmPBv9YJSQd8FywuRyAnGoC9mhjjs";
vi.mock("@/lib/server/siws", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/siws")>()),
  verifySigned: vi.fn(async () => ({ wallet: WALLET, params: { jurisdiction: 688 } })),
}));
vi.mock("@/app/api/clients/_helpers", () => ({
  clientIpOf: () => "203.0.113.9", ipRateLimitKey: (ip: string) => ip, rateLimited: () => false, insertNote: vi.fn(),
  DEGRADED_TTL_MESSAGE: "degraded",
}));
const shared = vi.hoisted(() => ({ limit: vi.fn<(key: string, limit: number, windowSeconds: number) => Promise<string>>() }));
vi.mock("@/lib/server/shared-rate-limit", () => ({ consumeSharedRateLimit: shared.limit }));
const db = vi.hoisted(() => ({ touched: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => { db.touched(); throw new Error("not in this test"); } }));

import { POST } from "@/app/api/passport/submit/route";

const call = () => POST(new Request("https://manci.test/api/passport/submit", { method: "POST", body: "{}" }));

beforeEach(() => {
  shared.limit.mockReset().mockResolvedValue("ok");
  db.touched.mockReset();
});

describe("/api/passport/submit shared limits", () => {
  it("429 when the wallet's shared cap is spent", async () => {
    shared.limit.mockResolvedValueOnce("limited");
    expect((await call()).status).toBe(429);
    expect(shared.limit).toHaveBeenCalledWith(`passport-submit:wallet:${WALLET}`, 3, 3_600);
    expect(db.touched).not.toHaveBeenCalled();
  });

  it("429 when the IP's shared cap is spent, whatever the wallet", async () => {
    shared.limit.mockResolvedValueOnce("ok").mockResolvedValueOnce("limited");
    expect((await call()).status).toBe(429);
    expect(shared.limit).toHaveBeenLastCalledWith("passport-submit:ip:203.0.113.9", 20, 3_600);
    expect(db.touched).not.toHaveBeenCalled();
  });
});
