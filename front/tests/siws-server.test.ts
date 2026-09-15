import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBase58Decoder } from "@solana/kit";
import { siwsMessage, type SiwsPayload, type SiwsRequestBody } from "@/lib/siws-client";

vi.mock("server-only", () => ({}));
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({ rpc }) }));
import { verifySigned } from "@/lib/server/siws";

const keys = generateKeyPairSync("ed25519");
const wallet = getBase58Decoder().decode(
  keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32),
);
const origin = "https://manci.test";
const consumed = new Set<string>();
function envelope(overrides: Partial<SiwsPayload> = {}): SiwsRequestBody {
  const payload: SiwsPayload = {
    v: 2, origin, network: "devnet", action: "test.private", wallet,
    nonce: crypto.randomUUID(), ts: new Date().toISOString(),
    params: { client_id: "dossier", amount: "7" }, ...overrides,
  };
  return {
    payload, publicKey: wallet,
    signature: sign(null, Buffer.from(siwsMessage(payload)), keys.privateKey).toString("base64"),
  };
}
function request(body = envelope(), requestOrigin = origin, url = `${origin}/api/private`) {
  return new Request(url, {
    method: "POST", headers: { "Content-Type": "application/json", origin: requestOrigin },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", origin);
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  consumed.clear();
  rpc.mockReset();
  rpc.mockImplementation(async (_name, args) => {
    const key = `${args.p_origin}:${args.p_network}:${args.p_wallet}:${args.p_nonce}`;
    const fresh = !consumed.has(key);
    consumed.add(key);
    return { data: fresh, error: null };
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("SIWS v2 authorization", () => {
  it("verifies a real ed25519 signature and atomically consumes the exact context", async () => {
    const body = envelope();
    await expect(verifySigned(request(body), "test.private")).resolves.toEqual({ wallet, params: body.payload.params });
    expect(rpc).toHaveBeenCalledWith("consume_siws_nonce", {
      p_origin: origin, p_network: "devnet", p_wallet: wallet,
      p_nonce: body.payload.nonce,
      p_expires_at: new Date(Date.parse(body.payload.ts) + 300_000).toISOString(),
    });
    await expect(verifySigned(request(body), "test.private")).rejects.toMatchObject({ status: 401 });
  });

  it("allows only one of concurrent copies even with separate Request instances", async () => {
    const body = envelope();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => verifySigned(request(body), "test.private")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(5);
  });

  it.each([
    ["action", { action: "another.action" }],
    ["network", { network: "mainnet" }],
    ["origin", { origin: "https://another.test" }],
    ["expired", { ts: new Date(Date.now() - 400_000).toISOString() }],
    ["future", { ts: new Date(Date.now() + 400_000).toISOString() }],
  ] as const)("rejects a valid signature with the wrong %s before DB access", async (_label, override) => {
    await expect(verifySigned(request(envelope(override)), "test.private")).rejects.toMatchObject({ status: 401 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects altered signed params and a swapped public key without consuming the nonce", async () => {
    const body = envelope();
    const altered = { ...body, payload: { ...body.payload, params: { amount: "7000" } } };
    await expect(verifySigned(request(altered), "test.private")).rejects.toMatchObject({ status: 401 });
    await expect(verifySigned(request({ ...body, publicKey: "11111111111111111111111111111111" }), "test.private")).rejects.toMatchObject({ status: 401 });
    expect(rpc).not.toHaveBeenCalled();
    await expect(verifySigned(request(body), "test.private")).resolves.toHaveProperty("wallet", wallet);
  });

  it("does not accept the old unsigned-origin v1 envelope", async () => {
    const body = envelope();
    const old = { ...body, payload: { ...body.payload, v: 1 } };
    const req = new Request(`${origin}/api/private`, { method: "POST", body: JSON.stringify(old) });
    await expect(verifySigned(req, "test.private")).rejects.toMatchObject({ status: 400 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin browser request even when the payload uses the configured origin", async () => {
    await expect(verifySigned(request(envelope(), "https://another.test"), "test.private")).rejects.toMatchObject({ status: 401 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails closed if the shared store errors or returns no boolean", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const reply of [{ data: null, error: { code: "PGRST202" } }, { data: null, error: null }]) {
      rpc.mockResolvedValueOnce(reply);
      await expect(verifySigned(request(), "test.private")).rejects.toMatchObject({ status: 503 });
    }
    log.mockRestore();
  });

  it("requires an explicit HTTPS production origin and ignores a forged Host", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    await expect(verifySigned(request(), "test.private")).rejects.toMatchObject({ status: 503 });
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://manci.test");
    await expect(verifySigned(request(), "test.private")).rejects.toMatchObject({ status: 503 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("allows a matching local origin only outside production", async () => {
    const local = "http://127.0.0.1:3000";
    const body = envelope({ origin: local });
    await expect(verifySigned(request(body, local, `${local}/api/private`), "test.private")).rejects.toMatchObject({ status: 401 });
    vi.stubEnv("NODE_ENV", "development");
    await expect(verifySigned(request(body, local, `${local}/api/private`), "test.private")).resolves.toHaveProperty("wallet", wallet);
  });
});
