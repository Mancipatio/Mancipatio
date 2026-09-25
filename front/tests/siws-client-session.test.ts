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

// Background reads (the admin menu counts, lib/admin-badges.ts) must never
// cost a per-request signature, and at most the one session prompt.
describe("signedFetch interactive modes", () => {
  it("interactive:false with no session throws WalletSessionRequiredError without a prompt or a request", async () => {
    const { signedFetch, WalletSessionRequiredError } = await import("@/lib/siws-client");
    await expect(signedFetch(session, "/api/admin/badges", "admin.badges", {}, { interactive: false }))
      .rejects.toBeInstanceOf(WalletSessionRequiredError);
    expect(signMessage).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("interactive:false with a live session makes exactly one session POST", async () => {
    const { signedFetch } = await import("@/lib/siws-client");
    await signedFetch(session, "/api/clients/me", "clients.me"); // starts the session
    signMessage.mockClear();
    fetchMock.mockClear();
    await signedFetch(session, "/api/admin/badges", "admin.badges", { fresh: true }, { interactive: false });
    expect(signMessage).not.toHaveBeenCalled();
    const calls = bodies();
    expect(calls.map((c) => c.path)).toEqual(["/api/admin/badges"]);
    expect(calls[0].body).toMatchObject({ session: true, payload: { action: "admin.badges", params: { fresh: true } } });
    expect(calls[0].body.signature).toBeUndefined();
  });

  it("interactive:false forgets a session the server refused (401) and never signs instead", async () => {
    const { signedFetch, hasWalletSession, WalletSessionRequiredError } = await import("@/lib/siws-client");
    await signedFetch(session, "/api/clients/me", "clients.me");
    signMessage.mockClear();
    fetchMock.mockImplementationOnce(async () => Response.json({ ok: false, error: "expired" }, { status: 401 }));
    await expect(signedFetch(session, "/api/admin/badges", "admin.badges", {}, { interactive: false }))
      .rejects.toBeInstanceOf(WalletSessionRequiredError);
    expect(signMessage).not.toHaveBeenCalled();
    expect(hasWalletSession(wallet)).toBe(false);
  });

  it("a write action is refused before any request in a non-interactive mode", async () => {
    const { signedFetch } = await import("@/lib/siws-client");
    for (const interactive of [false, "session-only"] as const) {
      await expect(signedFetch(session, "/api/clients/update", "clients.update", { id: "x" }, { interactive }))
        .rejects.toThrow(/needs a wallet signature/);
    }
    expect(signMessage).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('"session-only" starts the session once (one prompt), then reads over it', async () => {
    const { signedFetch } = await import("@/lib/siws-client");
    await signedFetch(session, "/api/admin/badges", "admin.badges", {}, { interactive: "session-only" });
    expect(signMessage).toHaveBeenCalledTimes(1);
    expect(bodies().map((c) => c.path)).toEqual(["/api/auth/session", "/api/admin/badges"]);
    expect(bodies()[1].body.session).toBe(true);
  });

  it('"session-only" costs one prompt, never two, when the session route fails', async () => {
    const { signedFetch, WalletSessionRequiredError } = await import("@/lib/siws-client");
    // e.g. SESSION_SECRET unset: /api/auth/session is not ok.
    fetchMock.mockImplementation(async (path) => path === "/api/auth/session"
      ? Response.json({ ok: false, error: "sessions are off" }, { status: 503 })
      : Response.json({ ok: true, data: {} }));
    await expect(signedFetch(session, "/api/admin/badges", "admin.badges", {}, { interactive: "session-only" }))
      .rejects.toBeInstanceOf(WalletSessionRequiredError);
    expect(signMessage).toHaveBeenCalledTimes(1);
    expect(bodies().map((c) => c.path)).toEqual(["/api/auth/session"]);
  });

  it('"session-only" turns a declined prompt into WalletSessionRequiredError and sends nothing', async () => {
    const { signedFetch, WalletSessionRequiredError } = await import("@/lib/siws-client");
    signMessage.mockRejectedValueOnce(new Error("User rejected the request"));
    await expect(signedFetch(session, "/api/admin/badges", "admin.badges", {}, { interactive: "session-only" }))
      .rejects.toBeInstanceOf(WalletSessionRequiredError);
    expect(signMessage).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('"session-only" never signs after a 401 over the session', async () => {
    const { signedFetch, WalletSessionRequiredError } = await import("@/lib/siws-client");
    fetchMock.mockImplementation(async (path) => path === "/api/auth/session"
      ? Response.json({ ok: true, data: { expires_at: new Date(Date.now() + 3_600_000).toISOString() } })
      : Response.json({ ok: false, error: "expired" }, { status: 401 }));
    await expect(signedFetch(session, "/api/admin/badges", "admin.badges", {}, { interactive: "session-only" }))
      .rejects.toBeInstanceOf(WalletSessionRequiredError);
    expect(signMessage).toHaveBeenCalledTimes(1);
    expect(bodies().every((c) => c.body?.signature === undefined || c.path === "/api/auth/session")).toBe(true);
  });

  it("admin.badges is a session read (so it rides the cookie and stays allowed in maintenance)", async () => {
    const { SESSION_READ_ACTIONS } = await import("@/lib/siws-session");
    const { refusedInMaintenance } = await import("@/lib/maintenance");
    expect(SESSION_READ_ACTIONS.has("admin.badges")).toBe(true);
    expect(refusedInMaintenance("admin.badges")).toBe(false);
  });
});
