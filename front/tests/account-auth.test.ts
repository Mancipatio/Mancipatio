import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({ rpc }) }));
import { ACCOUNT_COOKIE, issueAccountSession, readAccountSession, readActor } from "@/lib/server/account-auth";

const origin = "https://manci.test";
const accountId = "10000000-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", origin);
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  vi.stubEnv("SESSION_SECRET", "s".repeat(40));
  rpc.mockReset().mockResolvedValue({ data: true, error: null });
});
afterEach(() => vi.unstubAllEnvs());

function accountRequest(action: string, cookie: string | null, over: Record<string, unknown> = {}, headerOrigin: string | null = origin) {
  const payload = { v: 2, origin, network: "devnet", action, ts: new Date().toISOString(), nonce: crypto.randomUUID(), params: {}, ...over };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (headerOrigin) headers.origin = headerOrigin;
  if (cookie) headers.cookie = `${ACCOUNT_COOKIE}=${cookie}`;
  return new Request(`${origin}/api/account/me`, { method: "POST", headers, body: JSON.stringify({ payload, account: true }) });
}

describe("account session cookie", () => {
  it("round-trips and rejects tampering or another network", () => {
    const { token } = issueAccountSession(accountId, "devnet", origin);
    const req = (t: string) => new Request(origin, { headers: { cookie: `${ACCOUNT_COOKIE}=${t}` } });
    expect(readAccountSession(req(token))?.a).toBe(accountId);
    expect(readAccountSession(req(token.replace(/.$/, (c) => (c === "A" ? "B" : "A"))))).toBeNull();
    expect(readAccountSession(req(issueAccountSession(accountId, "mainnet", origin).token))).toBeNull();
  });

  it("authorizes an account actor with a live cookie and consumes the nonce", async () => {
    const { token } = issueAccountSession(accountId, "devnet", origin);
    const actor = await readActor(accountRequest("account.me", token), "account.me");
    expect(actor).toEqual({ kind: "account", accountId, params: {} });
    expect(rpc).toHaveBeenCalledWith("consume_siws_nonce", expect.objectContaining({ p_wallet: `account:${accountId}` }));
  });

  it.each([
    ["no cookie", null, {}, origin],
    ["another action", "cookie", { action: "account.update" }, origin],
    ["cross-site origin header", "cookie", {}, "https://evil.test"],
    ["stale timestamp", "cookie", { ts: new Date(Date.now() - 600_000).toISOString() }, origin],
  ] as const)("rejects %s", async (_label, cookie, over, headerOrigin) => {
    const token = cookie ? issueAccountSession(accountId, "devnet", origin).token : null;
    await expect(readActor(accountRequest("account.me", token, over, headerOrigin), "account.me")).rejects.toMatchObject({ status: expect.any(Number) });
  });
});
