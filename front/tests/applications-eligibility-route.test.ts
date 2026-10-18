// /api/applications/eligibility is a session read bound to the signer: the
// caller gets its own apply verdict (KYC/KYB) and nobody else's. The route
// used to be unsigned and answered any wallet named in the body with that
// wallet's compliance outcome (verified, rejected, suspended). Run against
// the in-memory Supabase stand-in; the signature check is mocked, as in
// tests/privacy-readers.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memorySupabase } from "./helpers/memory-supabase";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ verify: vi.fn(), tables: [] as string[] }));
const db = vi.hoisted(() => ({ ref: null as null | ReturnType<typeof import("./helpers/memory-supabase").memorySupabase> }));
vi.mock("@/lib/server/siws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/siws")>()),
  verifySigned: mocks.verify,
}));
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      mocks.tables.push(table);
      return db.ref!.client.from(table);
    },
  }),
}));

import { SiwsError } from "@/lib/server/siws";
import { POST } from "@/app/api/applications/eligibility/route";
import { SESSION_READ_ACTIONS, isSessionReadAction } from "@/lib/siws-session";

const WALLET = "11111111111111111111111111111111";
const OTHER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const UNKNOWN = "So11111111111111111111111111111111111111112";
const future = new Date(Date.now() + 30 * 86_400_000).toISOString();

const request = (body: unknown = {}) =>
  new Request("https://manci.test/api/applications/eligibility", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
const signedAs = (wallet: string) => mocks.verify.mockResolvedValue({ wallet, params: {}, via: "session" });
async function post(body: unknown = {}) {
  const res = await POST(request(body));
  return { res, body: (await res.json()) as { ok: boolean; data?: Record<string, unknown>; error?: string } };
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  db.ref = memorySupabase();
  mocks.tables.length = 0;
  mocks.verify.mockReset();
  db.ref.rows("clients").push(
    { id: "c-1", network: "devnet", wallet: WALLET, kyc_status: "verified", kyc_expires_at: future, created_at: "2026-01-01T00:00:00Z" },
    { id: "c-2", network: "devnet", wallet: OTHER, kyc_status: "suspended", kyc_expires_at: null, created_at: "2026-01-01T00:00:00Z" },
  );
});
afterEach(() => vi.unstubAllEnvs());

describe("the eligibility read is bound to the signer", () => {
  it("rejects an unsigned read before touching private storage", async () => {
    mocks.verify.mockRejectedValue(new SiwsError(401, "This action requires a wallet signature"));
    const { res, body } = await post({ wallet: OTHER });
    expect(res.status).toBe(401);
    expect(body.ok).toBe(false);
    expect(body.data).toBeUndefined();
    expect(mocks.tables).toEqual([]);
  });

  it("answers with the signer's own verdict and ignores a wallet supplied in the body", async () => {
    signedAs(WALLET);
    const { res, body } = await post({ wallet: OTHER });
    expect(res.status).toBe(200);
    expect(mocks.verify).toHaveBeenCalledWith(expect.any(Request), "applications.eligibility");
    expect(body.data).toMatchObject({
      hasClient: true, eligible: true, applicantKind: "individual", individualKycStatus: "verified", kybStatus: "none",
    });
    expect(body.data).not.toHaveProperty("id");
    // Nothing of the other wallet's dossier leaves the server.
    expect(JSON.stringify(body)).not.toMatch(/suspended|c-2/);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("a suspended signer learns its own outcome, and no more", async () => {
    signedAs(OTHER);
    const { body } = await post({ wallet: WALLET });
    expect(body.data).toMatchObject({ hasClient: true, eligible: false, applicantKind: null, kybStatus: "suspended" });
    expect(JSON.stringify(body)).not.toContain("c-1");
  });

  it("a signer without a dossier (nor an account wallet) is simply not eligible", async () => {
    signedAs(UNKNOWN);
    const { res, body } = await post();
    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ hasClient: false, eligible: false, applicantKind: null });
    expect(mocks.tables).toContain("account_wallets");
  });

  it("is a session read (no extra wallet prompt on /apply), with no body wallet left in the route", () => {
    expect(SESSION_READ_ACTIONS.has("applications.eligibility")).toBe(true);
    expect(isSessionReadAction("applications.eligibility")).toBe(true);
    const source = readFileSync(join(process.cwd(), "app/api/applications/eligibility/route.ts"), "utf8");
    expect(source).toContain('verifySigned(request, "applications.eligibility")');
    expect(source).not.toContain("BASE58_RE");
    expect(source).not.toMatch(/request\.json\(\)|body\.wallet|\.wallet\b.*trim\(\)/);
  });
});
