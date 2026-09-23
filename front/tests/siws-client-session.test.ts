import type { WalletSession } from "@solana/client";
import { address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wallet = address("11111111111111111111111111111111");
// These fake wallets return placeholder signatures for a placeholder key, so
// stub only the signing strategy (the client now refuses to send a signature
// it can prove invalid); formats and local checks: tests/siws-signing.test.ts.
vi.mock("@/lib/siws-signing", async (original) => ({
  ...(await original<typeof import("@/lib/siws-signing")>()),
  signSiwsMessage: async (walletSession: WalletSession, sign: NonNullable<WalletSession["signMessage"]>, message: string) =>
    ({ signature: await sign.call(walletSession, new TextEncoder().encode(message)), sigFormat: "raw" as const }),
}));
const store = new Map<string, string>();
const fetchMock = vi.fn<typeof fetch>();
const signMessage = vi.fn(async () => new Uint8Array(64).fill(1));
const session = { account: { address: wallet }, signMessage } as unknown as WalletSession;

beforeEach(() => {
  vi.resetModules();
  store.clear();
  signMessage.mockClear();
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  vi.stubGlobal("window", {
    location: { origin: "https://manci.test" },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
  });
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockImplementation(async (path) => path === "/api/auth/session"
    ? Response.json({ ok: true, data: { expires_at: new Date(Date.now() + 3_600_000).toISOString() } })
    : Response.json({ ok: true, data: { path } }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function bodies() {
  return fetchMock.mock.calls.map(([path, init]) => ({ path, body: init?.method === "POST" ? JSON.parse(init.body as string) : null }));
}

describe("wallet session in signedFetch", () => {
  it("signs once for the session, then reads without further prompts", async () => {
    const { signedFetch } = await import("@/lib/siws-client");
    await signedFetch(session, "/api/clients/me", "clients.me");
    await signedFetch(session, "/api/account/me", "account.me");
    expect(signMessage).toHaveBeenCalledTimes(1);
    const calls = bodies();
    expect(calls.map((c) => c.path)).toEqual(["/api/auth/session", "/api/clients/me", "/api/account/me"]);
    expect(calls[1].body).toMatchObject({ session: true, payload: { action: "clients.me" } });
    expect(calls[1].body.signature).toBeUndefined();
  });

  it("shares one session prompt between concurrent reads", async () => {
    const { signedFetch } = await import("@/lib/siws-client");
    await Promise.all([signedFetch(session, "/api/a", "clients.me"), signedFetch(session, "/api/b", "account.me")]);
    expect(signMessage).toHaveBeenCalledTimes(1);
  });

  it("always signs write actions", async () => {
    const { signedFetch } = await import("@/lib/siws-client");
    await signedFetch(session, "/api/clients/me", "clients.me");
    await signedFetch(session, "/api/clients/update", "clients.update", { id: "x" });
    expect(signMessage).toHaveBeenCalledTimes(2);
    expect(bodies().at(-1)!.body.signature).toEqual(expect.any(String));
  });

  it("falls back to a signature when the server rejects the session", async () => {
    const { signedFetch } = await import("@/lib/siws-client");
    await signedFetch(session, "/api/clients/me", "clients.me");
    fetchMock.mockImplementationOnce(async () => Response.json({ ok: false, error: "expired" }, { status: 401 }));
    await signedFetch(session, "/api/clients/me", "clients.me");
    expect(bodies().at(-1)!.body.signature).toEqual(expect.any(String));
  });
});
