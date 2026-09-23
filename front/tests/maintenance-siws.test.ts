import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBase58Decoder } from "@solana/kit";
import { siwsMessage, type SiwsPayload } from "@/lib/siws-client";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  flag: { enabled: false, message: null as string | null } as { enabled: boolean; message: string | null } | null,
}));
function from() {
  const q: Record<string, unknown> = {};
  Object.assign(q, {
    select: () => q, eq: () => q, abortSignal: () => q,
    maybeSingle: async () => ({ data: m.flag, error: null }),
  });
  return q;
}
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({ rpc: m.rpc, from }) }));

type Siws = typeof import("@/lib/server/siws");
type AccountAuth = typeof import("@/lib/server/account-auth");
let siws: Siws;
let accountAuth: AccountAuth;

const keys = generateKeyPairSync("ed25519");
const wallet = getBase58Decoder().decode(keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32));
const origin = "https://manci.test";
const accountId = "10000000-0000-4000-8000-000000000001";

function payload(action: string): SiwsPayload {
  return { v: 2, origin, network: "devnet", action, wallet, nonce: crypto.randomUUID(), ts: new Date().toISOString(), params: {} };
}
function post(body: unknown, cookie?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json", origin };
  if (cookie) headers.cookie = cookie;
  return new Request(`${origin}/api/private`, { method: "POST", headers, body: JSON.stringify(body) });
}
function signed(action: string) {
  const p = payload(action);
  return post({ payload: p, publicKey: wallet, signature: sign(null, Buffer.from(siwsMessage(p)), keys.privateKey).toString("base64") });
}
async function viaSession(action: string) {
  const { issueSessionToken } = await import("@/lib/server/siws-session");
  return post({ payload: payload(action), session: true }, `manci_session=${issueSessionToken(wallet, "devnet", origin)!.token}`);
}
function viaAccount(action: string) {
  const { token } = accountAuth.issueAccountSession(accountId, "devnet", origin);
  const { v, network, ts, nonce, params } = payload(action);
  return post({ payload: { v, origin, network, action, ts, nonce, params }, account: true }, `manci_account=${token}`);
}
const nonceCalls = () => m.rpc.mock.calls.filter(([name]) => name === "consume_siws_nonce").length;

beforeEach(async () => {
  vi.resetModules();
  siws = await import("@/lib/server/siws");
  accountAuth = await import("@/lib/server/account-auth");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", origin);
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  vi.stubEnv("SESSION_SECRET", "s".repeat(40));
  m.rpc.mockReset().mockResolvedValue({ data: true, error: null });
  m.flag = { enabled: true, message: "Program upgrade" };
});
afterEach(() => vi.unstubAllEnvs());

describe("verifySigned in maintenance", () => {
  it("refuses a signed write with 503 without consuming its nonce", async () => {
    const error = await siws.verifySigned(signed("clients.create"), "clients.create").catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 503, message: "Manci is in maintenance: Program upgrade" });
    expect(nonceCalls()).toBe(0);
    const res = siws.siwsErrorResponse(error);
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ ok: false, code: "maintenance", message: "Program upgrade" });
  });

  it("still accepts signed reads, sign-in and indexer repairs", async () => {
    for (const action of ["clients.me", "auth.session", "admin.reconcile"]) {
      await expect(siws.verifySigned(signed(action), action)).resolves.toHaveProperty("wallet", wallet);
    }
    expect(nonceCalls()).toBe(3);
  });

  it("allows session reads but refuses the pre-send policy check, signed or by session", async () => {
    await expect(siws.verifySigned(await viaSession("clients.me"), "clients.me")).resolves.toEqual({ wallet, params: {}, via: "session" });
    expect(nonceCalls()).toBe(1);
    await expect(siws.verifySigned(await viaSession("account.wallets.transaction"), "account.wallets.transaction"))
      .rejects.toMatchObject({ status: 503 });
    await expect(siws.verifySigned(signed("account.wallets.transaction"), "account.wallets.transaction"))
      .rejects.toMatchObject({ status: 503 });
    expect(nonceCalls()).toBe(1);
  });

  it("reports authentication failures before maintenance", async () => {
    const p = payload("clients.create");
    const forged = post({ payload: p, publicKey: wallet, signature: Buffer.alloc(64).toString("base64") });
    await expect(siws.verifySigned(forged, "clients.create")).rejects.toMatchObject({ status: 401 });
  });

  it("lets the same writes through once maintenance ends", async () => {
    m.flag = null;
    await expect(siws.verifySigned(signed("clients.create"), "clients.create")).resolves.toHaveProperty("wallet", wallet);
    expect(nonceCalls()).toBe(1);
  });
});

describe("account-session requests in maintenance", () => {
  it("refuses an account write before its nonce and maps it to 503", async () => {
    const error = await accountAuth.readActor(viaAccount("account.update"), "account.update").catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 503 });
    expect(nonceCalls()).toBe(0);
    const { accountErrorResponse } = await import("@/lib/server/account-profile");
    const res = accountErrorResponse(error);
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ code: "maintenance", error: "Manci is in maintenance: Program upgrade" });
  });

  it("still serves account reads", async () => {
    await expect(accountAuth.readActor(viaAccount("account.me"), "account.me")).resolves.toEqual({ kind: "account", accountId, params: {} });
    expect(nonceCalls()).toBe(1);
  });

  it("refuses wallet-signed account writes through the same verifier", async () => {
    await expect(accountAuth.readActor(signed("account.wallets.primary"), "account.wallets.primary")).rejects.toMatchObject({ status: 503 });
    expect(nonceCalls()).toBe(0);
  });
});
