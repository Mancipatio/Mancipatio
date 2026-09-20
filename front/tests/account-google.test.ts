import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
type Filter = [string, string, unknown];
const state = vi.hoisted(() => ({
  rows: [] as Row[],
  inserts: [] as Row[],
  mutations: [] as Array<{ operation: string; table: string; filters: Filter[] }>,
  clientOptions: [] as Row[],
  selectError: null as unknown,
  insertError: null as unknown,
  cleanupError: null as unknown,
  verifySigned: vi.fn(),
  generateAuthUrl: vi.fn(),
  getToken: vi.fn(),
  verifyIdToken: vi.fn(),
  getAccountProfile: vi.fn(),
  consumeAccountRateLimit: vi.fn(),
  accountResponse: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/server/siws", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/server/siws")>(),
  verifySigned: state.verifySigned,
}));

vi.mock("google-auth-library", () => ({
  CodeChallengeMethod: { S256: "S256" },
  OAuth2Client: class {
    constructor(options: Row) { state.clientOptions.push(options); }
    generateAuthUrl = state.generateAuthUrl;
    getToken = state.getToken;
    verifyIdToken = state.verifyIdToken;
  },
}));

vi.mock("@/lib/server/account-profile", async () => {
  const { SiwsError } = await import("@/lib/server/siws");
  const { NextResponse: Response } = await import("next/server");
  return {
    getAccountProfile: state.getAccountProfile,
    consumeAccountRateLimit: state.consumeAccountRateLimit,
    accountResponse: state.accountResponse,
    accountErrorResponse: (error: unknown) => Response.json({ ok: false, error: error instanceof SiwsError ? error.message : "Account unavailable" },
      { status: error instanceof SiwsError ? error.status : 503, headers: { "Cache-Control": "no-store" } }),
  };
});

vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    rpc: state.rpc,
    from: (table: string) => {
      const filters: Filter[] = [];
      let operation = "select";
      const matches = (row: Row) => filters.every(([op, field, value]) =>
        op === "lt" ? String(row[field]) < String(value) : row[field] === value);
      const builder = {
        select: () => builder,
        delete: () => { operation = "delete"; return builder; },
        eq: (field: string, value: unknown) => { filters.push(["eq", field, value]); return builder; },
        lt: (field: string, value: unknown) => { filters.push(["lt", field, value]); return builder; },
        insert: async (row: Row) => {
          state.inserts.push({ ...row });
          if (!state.insertError) state.rows.push({ ...row });
          return { data: null, error: state.insertError };
        },
        maybeSingle: async () => ({ data: state.rows.find(matches) ?? null, error: state.selectError }),
        then: (resolve: (result: unknown) => unknown, reject?: (error: unknown) => unknown) => {
          state.mutations.push({ operation, table, filters: [...filters] });
          if (operation === "delete" && !state.cleanupError) state.rows = state.rows.filter((row) => !matches(row));
          return Promise.resolve({ data: null, error: state.cleanupError }).then(resolve, reject);
        },
      };
      return builder;
    },
  }),
}));

import { startGoogleLink, finishGoogleLink, unlinkGoogle } from "@/lib/server/account-google";
import { SiwsError } from "@/lib/server/siws";

const ORIGIN = "https://www.mancipatio.io";
const CALLBACK = `${ORIGIN}/api/account/google/callback`;
const WALLET = "11111111111111111111111111111111";
const OAUTH_STATE = "A".repeat(43);
const BROWSER_TOKEN = "B".repeat(43);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const nonce = (value = OAUTH_STATE) => sha256(`manci:google-link:nonce:${value}`);

function post(action: "start" | "unlink" = "start") {
  return new Request(`${ORIGIN}/api/account/google/${action}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
}
function callback(query: Record<string, string> = {}, cookie: string | null = BROWSER_TOKEN) {
  const url = new URL(CALLBACK);
  for (const [key, value] of Object.entries({ state: OAUTH_STATE, code: "authorization-code", ...query })) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url, { headers: cookie === null ? {} : { cookie: `manci_google_link=${cookie}` } });
}
function stored(overrides: Row = {}) {
  const row = {
    state_hash: sha256(OAUTH_STATE), browser_hash: sha256(BROWSER_TOKEN), wallet: WALLET,
    network: "devnet", code_verifier: "V".repeat(43), redirect_uri: CALLBACK,
    expires_at: new Date(Date.now() + 600_000).toISOString(), ...overrides,
  };
  state.rows.push(row);
  return row;
}
function claims(overrides: Row = {}) {
  return { sub: "google-subject-123", email: "Person@Example.com", email_verified: true,
    nonce: nonce(), aud: "google-client", azp: "google-client", ...overrides };
}
function redirect(response: NextResponse, result: string, clearsCookie = true) {
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe(`${ORIGIN}/account?google=${result}`);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  if (clearsCookie) expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  else expect(response.headers.get("set-cookie")).toBeNull();
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", ORIGIN);
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  vi.stubEnv("GOOGLE_CLIENT_ID", "google-client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-secret");
  state.rows = []; state.inserts = []; state.mutations = []; state.clientOptions = [];
  state.selectError = null; state.insertError = null; state.cleanupError = null;
  state.verifySigned.mockResolvedValue({ wallet: WALLET, params: {} });
  state.getAccountProfile.mockResolvedValue({ wallet: WALLET, network: "devnet" });
  state.consumeAccountRateLimit.mockResolvedValue(undefined);
  state.accountResponse.mockImplementation(async (wallet, network) => NextResponse.json({ ok: true, data: { wallet, network } },
    { headers: { "Cache-Control": "no-store" } }));
  state.generateAuthUrl.mockReturnValue("https://accounts.google.com/o/oauth2/v2/auth?test=1");
  state.getToken.mockResolvedValue({ tokens: { id_token: "raw-id-token", access_token: "raw-access-token", refresh_token: "raw-refresh-token" } });
  state.verifyIdToken.mockResolvedValue({ getPayload: () => claims() });
  // Model the RPC boundary only; the separate PostgreSQL suite verifies its
  // profile lock and atomic state consumption against the actual migration.
  state.rpc.mockImplementation(async (name: string, params: Row) => {
    if (name === "unlink_account_google") {
      state.rows = state.rows.filter((row) => row.wallet !== params.p_wallet || row.network !== params.p_network);
      return { data: true, error: null };
    }
    const index = state.rows.findIndex((row) => row.state_hash === params.p_state_hash &&
      row.browser_hash === params.p_browser_hash && row.network === params.p_network);
    if (index < 0) return { data: false, error: null };
    state.rows.splice(index, 1);
    return { data: true, error: null };
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("wallet-authorized Google linking start", () => {
  it("binds the signed wallet/network to independent browser state, PKCE, and OIDC nonce", async () => {
    const response = await startGoogleLink(post());
    expect(response.status).toBe(200);
    expect(state.verifySigned).toHaveBeenCalledWith(expect.any(Request), "account.google.start");
    expect(state.consumeAccountRateLimit).toHaveBeenCalledWith(`google-start:devnet:${WALLET}`, 5, 600);
    expect(state.getAccountProfile).toHaveBeenCalledWith(WALLET, "devnet");
    const options = state.generateAuthUrl.mock.calls[0][0];
    const cookie = response.cookies.get("manci_google_link")!;
    const row = state.inserts[0];
    expect(options).toMatchObject({ scope: ["openid", "email"], access_type: "online", response_type: "code", code_challenge_method: "S256" });
    expect(options.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(options.state).not.toBe(cookie.value);
    expect(row).toMatchObject({ wallet: WALLET, network: "devnet", state_hash: sha256(options.state), browser_hash: sha256(cookie.value), redirect_uri: CALLBACK });
    expect(options.nonce).toBe(nonce(options.state));
    expect(options.code_challenge).toBe(createHash("sha256").update(String(row.code_verifier)).digest("base64url"));
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/api/account/google", maxAge: 600 });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(state.clientOptions[0]).toMatchObject({ clientId: "google-client", redirectUri: CALLBACK, transporterOptions: { timeout: 15000, retry: false } });
    expect(JSON.stringify(row)).not.toContain(options.state);
    expect(JSON.stringify(row)).not.toContain(cookie.value);
    expect(await response.json()).toEqual({ ok: true, data: { url: state.generateAuthUrl.mock.results[0].value } });
  });

  it.each([{ wallet: "attacker" }, { email: "attacker@example.com" }, { google_sub: "attacker" }, { network: "mainnet" }, { redirect_uri: "https://evil.example" }])
  ("rejects frontend identity or redirect input %j", async (params) => {
    state.verifySigned.mockResolvedValue({ wallet: WALLET, params });
    expect((await startGoogleLink(post())).status).toBe(400);
    expect(state.inserts).toEqual([]);
    expect(state.generateAuthUrl).not.toHaveBeenCalled();
  });

  it("does not create OAuth state when the signature or its durable nonce is rejected", async () => {
    state.verifySigned.mockRejectedValue(new SiwsError(401, "Invalid or reused signature"));
    expect((await startGoogleLink(post())).status).toBe(401);
    expect(state.inserts).toEqual([]);
    expect(state.getAccountProfile).not.toHaveBeenCalled();
  });

  it.each(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"])("fails closed when %s is not configured", async (key) => {
    vi.stubEnv(key, " ");
    expect((await startGoogleLink(post())).status).toBe(503);
    expect(state.inserts).toEqual([]);
  });

  it("does not mint a state after rate-limit refusal", async () => {
    state.consumeAccountRateLimit.mockRejectedValue(new SiwsError(429, "Too many requests"));
    expect((await startGoogleLink(post())).status).toBe(429);
    expect(state.inserts).toEqual([]);
  });

  it("returns unavailable without a browser cookie when saving state fails", async () => {
    state.insertError = { message: "db unavailable" };
    const response = await startGoogleLink(post());
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(state.generateAuthUrl).not.toHaveBeenCalled();
  });

  it("never logs or exposes an unexpected provider diagnostic", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    state.generateAuthUrl.mockImplementation(() => { throw new Error("provider code=private-code token=private-token"); });
    const response = await startGoogleLink(post());
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await response.text()).not.toContain("private-");
    expect(log).not.toHaveBeenCalled();
  });
});

describe("Google callback authorization and identity", () => {
  it.each([
    ["NEXT_PUBLIC_NETWORK", "misconfigured-network"],
    ["NEXT_PUBLIC_SITE_URL", "https://misconfigured.example/account"],
  ])("handles invalid %s without exposing config or consuming a pending attempt", async (key, value) => {
    stored();
    vi.stubEnv(key, value);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await finishGoogleLink(callback());
    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).not.toContain(value);
    expect(state.rows).toHaveLength(1);
    expect(state.mutations).toEqual([]);
    expect(state.getToken).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong browser", OAUTH_STATE, "C".repeat(43)],
    ["wrong state", "C".repeat(43), BROWSER_TOKEN],
    ["missing cookie", OAUTH_STATE, null],
    ["malformed state", "bad-state", BROWSER_TOKEN],
  ])("rejects %s without deleting another valid attempt", async (_name, oauthState, cookie) => {
    stored();
    redirect(await finishGoogleLink(callback({ state: oauthState! }, cookie)), "expired", false);
    expect(state.rows).toHaveLength(1);
    expect(state.getToken).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("cannot consume an attempt belonging to a different network", async () => {
    stored({ network: "mainnet" });
    redirect(await finishGoogleLink(callback()), "expired", false);
    expect(state.rows).toHaveLength(1);
    expect(state.getToken).not.toHaveBeenCalled();
  });

  it.each([
    { expires_at: "2000-01-01T00:00:00Z" }, { expires_at: "invalid" },
    { redirect_uri: "https://old.example/api/account/google/callback" },
  ])("discards an expired or differently configured attempt %j", async (overrides) => {
    stored(overrides);
    redirect(await finishGoogleLink(callback()), "expired");
    expect(state.rows).toEqual([]);
    expect(state.getToken).not.toHaveBeenCalled();
  });

  it("consumes a matched Google cancellation without changing an account", async () => {
    stored();
    redirect(await finishGoogleLink(callback({ error: "access_denied" })), "cancelled");
    expect(state.rows).toEqual([]);
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.getToken).not.toHaveBeenCalled();
  });

  it("preserves the cookie and attempt on a transient state lookup failure", async () => {
    stored(); state.selectError = { message: "unavailable" };
    redirect(await finishGoogleLink(callback()), "unavailable", false);
    expect(state.rows).toHaveLength(1);
  });

  it("returns unavailable if the provider was disabled after a signed start", async () => {
    stored(); vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    redirect(await finishGoogleLink(callback()), "unavailable");
    expect(state.rows).toEqual([]);
    expect(state.getToken).not.toHaveBeenCalled();
  });

  it("uses Google's verified identity with exact audience, PKCE, and atomic state consumption", async () => {
    const row = stored();
    redirect(await finishGoogleLink(callback({ email: "attacker@example.com", wallet: "attacker", sub: "attacker" })), "connected");
    expect(state.getToken).toHaveBeenCalledWith({ code: "authorization-code", codeVerifier: row.code_verifier, redirect_uri: CALLBACK });
    expect(state.verifyIdToken).toHaveBeenCalledWith({ idToken: "raw-id-token", audience: "google-client" });
    expect(state.rpc).toHaveBeenCalledExactlyOnceWith("complete_account_google_link", {
      p_state_hash: row.state_hash, p_browser_hash: row.browser_hash, p_network: "devnet",
      p_sub: "google-subject-123", p_email: "person@example.com",
    });
    expect(state.rows).toEqual([]);
    expect(state.inserts).toEqual([]);
    expect(JSON.stringify(state.rpc.mock.calls)).not.toContain("raw-");
    // Reusing even the original cookie cannot replay a consumed state.
    redirect(await finishGoogleLink(callback()), "expired", false);
    expect(state.getToken).toHaveBeenCalledTimes(1);
  });

  it.each([
    { nonce: "wrong-nonce" }, { nonce: undefined }, { email_verified: false }, { email_verified: "true" },
    { azp: "different-client" }, { sub: "" }, { sub: "S".repeat(256) }, { email: "not-an-email" },
  ])("rejects an unacceptable identity proof %j", async (overrides) => {
    stored(); state.verifyIdToken.mockResolvedValue({ getPayload: () => claims(overrides) });
    redirect(await finishGoogleLink(callback()), "failed");
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.rows).toEqual([]);
  });

  it("accepts a single-audience token without optional azp", async () => {
    stored(); state.verifyIdToken.mockResolvedValue({ getPayload: () => claims({ azp: undefined }) });
    redirect(await finishGoogleLink(callback()), "connected");
  });

  it.each(["exchange", "verification", "missing-token"])("does not save or log a failed %s", async (failure) => {
    stored();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("provider code=private-code id_token=raw-id-token refresh_token=raw-refresh-token");
    if (failure === "exchange") state.getToken.mockRejectedValue(error);
    if (failure === "verification") state.verifyIdToken.mockRejectedValue(error);
    if (failure === "missing-token") state.getToken.mockResolvedValue({ tokens: { access_token: "raw-access-token" } });
    const response = await finishGoogleLink(callback());
    redirect(response, "failed");
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.rows).toEqual([]);
    expect(log).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("raw-");
  });

  it("does not report connected if unlink consumed the state during token exchange", async () => {
    stored();
    let release!: (value: unknown) => void;
    let signalExchange!: () => void;
    const exchanging = new Promise<void>((resolve) => { signalExchange = resolve; });
    state.getToken.mockImplementation(() => { signalExchange(); return new Promise((resolve) => { release = resolve; }); });
    const pending = finishGoogleLink(callback());
    await exchanging;
    expect((await unlinkGoogle(post("unlink"))).status).toBe(200);
    release({ tokens: { id_token: "raw-id-token" } });
    redirect(await pending, "expired");
    expect(state.rows).toEqual([]);
  });
});

describe("wallet-authorized unlink", () => {
  it("uses the signed wallet and active network, returns only the account projection", async () => {
    stored();
    const response = await unlinkGoogle(post("unlink"));
    expect(response.status).toBe(200);
    expect(state.verifySigned).toHaveBeenCalledWith(expect.any(Request), "account.google.unlink");
    expect(state.rpc).toHaveBeenCalledExactlyOnceWith("unlink_account_google", { p_wallet: WALLET, p_network: "devnet" });
    expect(state.accountResponse).toHaveBeenCalledWith(WALLET, "devnet");
    expect(state.rows).toEqual([]);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects unsigned or frontend-selected identity", async () => {
    state.verifySigned.mockRejectedValueOnce(new SiwsError(401, "Signature required"));
    expect((await unlinkGoogle(post("unlink"))).status).toBe(401);
    state.verifySigned.mockResolvedValueOnce({ wallet: WALLET, params: { wallet: "other-wallet" } });
    expect((await unlinkGoogle(post("unlink"))).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it.each([{ data: false, error: null }, { data: null, error: { message: "db unavailable" } }])
  ("does not claim unlink success for an unsuccessful RPC %j", async (result) => {
    state.rpc.mockResolvedValue(result);
    expect((await unlinkGoogle(post("unlink"))).status).toBe(503);
    expect(state.accountResponse).not.toHaveBeenCalled();
  });
});
