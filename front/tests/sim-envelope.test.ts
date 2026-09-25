// The simulator's SIWS envelope (scripts/sim/lib/http.ts) against the REAL
// server verifier (lib/server/siws.ts verifySigned): signature path, session
// path with the manci_session cookie the jar keeps, and the refusals the edge
// cohort relies on. The nonce store is mocked; nothing leaves the process.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSigner, getUtf8Encoder, verifySignature } from "@solana/kit";

vi.mock("server-only", () => ({}));
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({ rpc }) }));
vi.mock("@/lib/server/maintenance", async (original) => ({
  ...(await original<typeof import("@/lib/server/maintenance")>()),
  assertActionWritable: async () => {},
}));

import { siwsMessage } from "@/lib/siws-client";
import { SESSION_COOKIE } from "@/lib/siws-session";
import { verifySigned } from "@/lib/server/siws";
import { issueSessionToken } from "@/lib/server/siws-session";
import { buildPayload, classesFor, classifyStatus, parseOnboardingPath, sessionCookieFrom, signEnvelope } from "@/scripts/sim/lib/http";
import { SITE_ORIGIN } from "@/scripts/sim/lib/constants";

const NONCE_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE_ORIGIN);
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  vi.stubEnv("SESSION_SECRET", "s".repeat(48));
  rpc.mockReset().mockResolvedValue({ data: true, error: null });
});
afterEach(() => vi.unstubAllEnvs());

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${SITE_ORIGIN}/api/clients/me`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: SITE_ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

describe("payload and signature", () => {
  it("builds the browser's v2 payload with a fresh v4 nonce", async () => {
    const signer = await generateKeyPairSigner();
    const a = buildPayload({ action: "clients.me", wallet: signer.address, params: {} });
    const b = buildPayload({ action: "clients.me", wallet: signer.address, params: {} });
    expect(a).toMatchObject({ v: 2, origin: "https://www.manci.io", network: "devnet", action: "clients.me", wallet: signer.address, params: {} });
    expect(a.nonce).toMatch(NONCE_V4);
    expect(a.nonce).not.toBe(b.nonce);
    expect(Math.abs(Date.parse(a.ts) - Date.now())).toBeLessThan(5_000);
  });

  it("signs the exact siwsMessage bytes and sends {payload, signature, publicKey, sigFormat:'raw'}", async () => {
    const signer = await generateKeyPairSigner();
    const payload = buildPayload({ action: "tos.accept", wallet: signer.address, params: { version: "2026-07-18" } });
    const body = await signEnvelope(signer, payload);
    expect(Object.keys(body).sort()).toEqual(["payload", "publicKey", "sigFormat", "signature"]);
    expect(body.publicKey).toBe(signer.address);
    expect(body.sigFormat).toBe("raw");
    const signature = new Uint8Array(Buffer.from(body.signature, "base64"));
    expect(signature).toHaveLength(64);
    const message = getUtf8Encoder().encode(siwsMessage(payload));
    expect(await verifySignature(signer.keyPair.publicKey, signature as never, message)).toBe(true);
  });

  it("is accepted by the server verifier and consumes the nonce once", async () => {
    const signer = await generateKeyPairSigner();
    const body = await signEnvelope(signer, buildPayload({ action: "clients.me", wallet: signer.address, params: {} }));
    await expect(verifySigned(post(body), "clients.me")).resolves.toMatchObject({ wallet: signer.address, via: "signature" });
    expect(rpc).toHaveBeenCalledWith("consume_siws_nonce", expect.objectContaining({ p_nonce: body.payload.nonce, p_origin: SITE_ORIGIN, p_network: "devnet" }));
    // The shared store answers false for a reused nonce: the replay case of the edge cohort.
    rpc.mockResolvedValueOnce({ data: false, error: null });
    await expect(verifySigned(post(body), "clients.me")).rejects.toMatchObject({ status: 401 });
  });

  it.each([
    ["a stale ts", { ts: new Date(Date.now() - 400_000).toISOString() }, {}, 401],
    ["the apex origin", { origin: "https://manci.io" }, {}, 401],
    ["mainnet", { network: "mainnet" }, {}, 401],
    ["a foreign Origin header", {}, { Origin: "https://evil.example" }, 401],
  ] as const)("refuses %s (the edge cohort's expectation)", async (_label, override, headers, status) => {
    const signer = await generateKeyPairSigner();
    const body = await signEnvelope(signer, buildPayload({ action: "clients.me", wallet: signer.address, params: {}, ...override }));
    await expect(verifySigned(post(body, headers), "clients.me")).rejects.toMatchObject({ status });
  });

  it("refuses a signature for another action", async () => {
    const signer = await generateKeyPairSigner();
    const body = await signEnvelope(signer, buildPayload({ action: "account.me", wallet: signer.address, params: {} }));
    await expect(verifySigned(post(body), "account.update")).rejects.toMatchObject({ status: 401 });
  });
});

describe("wallet session", () => {
  it("parses the manci_session cookie and the server accepts {payload, session:true} for a read", async () => {
    const signer = await generateKeyPairSigner();
    const issued = issueSessionToken(signer.address, "devnet", SITE_ORIGIN)!;
    const headers = new Headers();
    headers.append("set-cookie", `${SESSION_COOKIE}=${issued.token}; Path=/api; HttpOnly; SameSite=Strict; Secure`);
    const cookie = sessionCookieFrom(headers);
    expect(cookie).toBe(`${SESSION_COOKIE}=${issued.token}`);
    const payload = buildPayload({ action: "clients.me", wallet: signer.address, params: {} });
    await expect(verifySigned(post({ payload, session: true }, { Cookie: cookie! }), "clients.me")).resolves.toMatchObject({ via: "session" });
  });

  it("refuses a write on the session cookie (the edge cohort's session-write case)", async () => {
    const signer = await generateKeyPairSigner();
    const issued = issueSessionToken(signer.address, "devnet", SITE_ORIGIN)!;
    const payload = buildPayload({ action: "tos.accept", wallet: signer.address, params: { version: "2026-07-18" } });
    const request = new Request(`${SITE_ORIGIN}/api/tos/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: SITE_ORIGIN, Cookie: `${SESSION_COOKIE}=${issued.token}` },
      body: JSON.stringify({ payload, session: true }),
    });
    await expect(verifySigned(request, "tos.accept")).rejects.toMatchObject({ status: 401 });
  });

  it("returns null when no session cookie is set", () => {
    expect(sessionCookieFrom(new Headers({ "set-cookie": "other=1; Path=/" }))).toBeNull();
  });
});

describe("helpers", () => {
  it("classifies statuses against expectations", () => {
    expect(classifyStatus(200, "2xx")).toBe("ok");
    expect(classifyStatus(401, 401)).toBe("expected-error");
    expect(classifyStatus(202, [200, 202])).toBe("ok");
    expect(classifyStatus(409, "4xx")).toBe("expected-error");
    expect(classifyStatus(200, 400)).toBe("unexpected-2xx");
    expect(classifyStatus(403, "2xx")).toBe("unexpected-4xx");
    expect(classifyStatus(502, "4xx")).toBe("5xx");
    expect(classifyStatus(0, "2xx")).toBe("network");
  });

  it("paces writes, verification submits and reads apart", () => {
    expect(classesFor("verification.submit")).toEqual(["write", "verify"]);
    expect(classesFor("clients.me")).toEqual(["read"]);
    expect(classesFor("otc.create")).toEqual(["write"]);
  });

  it("parses onboarding links", () => {
    expect(parseOnboardingPath("/onboarding/10000000-0000-4000-8000-000000000001?t=abc123")).toEqual({
      clientId: "10000000-0000-4000-8000-000000000001",
      token: "abc123",
    });
    expect(parseOnboardingPath("https://evil.example/onboarding/x?t=1")).toBeNull();
    expect(parseOnboardingPath(null)).toBeNull();
  });
});
