import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBase58Decoder } from "@solana/kit";
import { siwsMessage, type SiwsPayload } from "@/lib/siws-client";
vi.mock("server-only", () => ({}));
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({ rpc }) }));
import { POST } from "@/app/api/clients/link-wallet/route";

const keys = generateKeyPairSync("ed25519");
const wallet = getBase58Decoder().decode(keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32));
const origin = "https://manci.test";
const token = "fixture-invitation-secret";
const id = "10000000-0000-4000-8000-000000000001";
function body(overrides: Partial<SiwsPayload> = {}) {
  const payload: SiwsPayload = {
    v: 2, origin, network: "devnet", action: "clients.linkWallet", wallet,
    nonce: crypto.randomUUID(), ts: new Date().toISOString(),
    params: { client_id: id, invitation_hash: createHash("sha256").update(token).digest("hex") },
    ...overrides,
  };
  return { payload, publicKey: wallet, signature: sign(null, Buffer.from(siwsMessage(payload)), keys.privateKey).toString("base64"), invitation_token: token };
}
function request(input: unknown) {
  return new Request(`${origin}/api/clients/link-wallet`, {
    method: "POST", headers: { "Content-Type": "application/json", origin, "x-real-ip": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
}
const bindingCalls = () => rpc.mock.calls.filter(([name]) => name === "link_client_wallet");
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("NEXT_PUBLIC_SITE_URL", origin); vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  rpc.mockReset();
  rpc.mockImplementation(async (name) => ({ data: name === "consume_siws_nonce" ? true : { status: "linked", already_linked: false }, error: null }));
});
afterEach(() => vi.unstubAllEnvs());

describe("invitation wallet ownership route", () => {
  it("binds only the actual signer, client ID, invitation and network", async () => {
    const res = await POST(request({ ...body(), wallet: "11111111111111111111111111111111" }));
    expect(res.status).toBe(200);
    expect(bindingCalls()).toEqual([["link_client_wallet", { p_client_id: id, p_token: token, p_wallet: wallet, p_network: "devnet" }]]);
  });
  it("rejects token-only legacy callers", async () => {
    const res = await POST(request({ client_id: id, token, wallet }));
    expect(res.status).toBe(400); expect(rpc).not.toHaveBeenCalled();
  });
  it("rejects an invitation token substituted after the signature", async () => {
    const res = await POST(request({ ...body(), invitation_token: "another-invitation" }));
    expect(res.status).toBe(401); expect(bindingCalls()).toHaveLength(0);
  });
  it("rejects changing the signed dossier or signing for the wrong network", async () => {
    const signed = body();
    const altered = { ...signed, payload: { ...signed.payload, params: { ...signed.payload.params, client_id: "10000000-0000-4000-8000-000000000002" } } };
    expect((await POST(request(altered))).status).toBe(401);
    expect((await POST(request(body({ network: "mainnet" })))).status).toBe(401);
    expect(bindingCalls()).toHaveLength(0);
  });
  it.each([
    ["invalid_invitation", 401], ["expired", 401], ["wallet_conflict", 409],
    ["wallet_in_use", 409], ["terminal_kyc", 403],
  ])("reports atomic DB denial %s without a false success", async (status, expectedStatus) => {
    rpc.mockImplementation(async (name) => ({ data: name === "consume_siws_nonce" ? true : { status }, error: null }));
    const res = await POST(request(body()));
    expect(res.status).toBe(expectedStatus);
    expect((await res.json()).ok).toBe(false);
  });
  it("accepts an idempotent same-wallet binding result", async () => {
    rpc.mockImplementation(async (name) => ({ data: name === "consume_siws_nonce" ? true : { status: "linked", already_linked: true }, error: null }));
    const res = await POST(request(body()));
    expect(await res.json()).toEqual({ ok: true, data: { linked: true, alreadyLinked: true } });
  });
  it("does not fall back to an unguarded update when the migration is missing", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    rpc.mockImplementation(async (name) => name === "consume_siws_nonce" ? { data: true, error: null } : { data: null, error: { code: "PGRST202" } });
    expect((await POST(request(body()))).status).toBe(503);
    log.mockRestore();
  });
});
