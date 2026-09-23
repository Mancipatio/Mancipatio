// Client half of hardware-wallet SIWS: createSignedRequest picks the format
// (raw / wallet-wrapped off-chain / our own off-chain envelope) with one
// prompt where possible, and the real server verifier accepts the result.
// Wallets are simulated with real ed25519 keys; the Ledger simulations follow
// the documented off-chain layouts, built here independently of the app code.
import type { WalletSession } from "@solana/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  address,
  generateKeyPair,
  getAddressEncoder,
  getAddressFromPublicKey,
  signBytes,
  type Address,
} from "@solana/kit";

vi.mock("server-only", () => ({}));
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({ rpc }) }));

const origin = "https://manci.test";
const DOMAIN = Buffer.from("\xffsolana offchain", "latin1");
const store = new Map<string, string>();
let keys: CryptoKeyPair;
let wallet: Address;

function v0Envelope(text: string) {
  const body = Buffer.from(text, "utf8");
  const format = /^[\x20-\x7e]+$/.test(text) ? 0 : 1;
  return new Uint8Array(Buffer.concat([
    DOMAIN, Buffer.from([0]), Buffer.alloc(32), Buffer.from([format, 1]),
    Buffer.from(getAddressEncoder().encode(address(wallet))),
    Buffer.from([body.length & 0xff, body.length >> 8]), body,
  ]));
}
function legacyEnvelope(text: string) {
  const body = Buffer.from(text, "utf8");
  const format = /^[\x20-\x7e]+$/.test(text) ? 0 : 1;
  return new Uint8Array(Buffer.concat([DOMAIN, Buffer.from([0, format, body.length & 0xff, body.length >> 8]), body]));
}
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const sign = (bytes: Uint8Array) => signBytes(keys.privateKey, bytes);

/** Hot wallet: signs exactly the bytes it is given. */
const softwareWallet = () => vi.fn(async (bytes: Uint8Array) => sign(bytes));
/** Ledger-aware wallet that wraps the requested text itself. */
const wrappingWallet = (wrap: (text: string) => Uint8Array) => vi.fn(async (bytes: Uint8Array) => sign(wrap(decode(bytes))));
/** Wallet that forwards bytes to a Ledger: anything but an off-chain message is refused. */
const forwardingLedger = (refusal = "Ledger device: UNKNOWN_ERROR (0x6a81)") => vi.fn(async (bytes: Uint8Array) => {
  if (bytes[0] !== 0xff) throw new Error(refusal);
  return sign(bytes);
});

function session(signMessage: (bytes: Uint8Array) => Promise<Uint8Array>): WalletSession {
  return { account: { address: wallet, publicKey: new Uint8Array(32) }, signMessage } as unknown as WalletSession;
}

async function serverAccepts(body: unknown, action: string) {
  const { verifySigned } = await import("@/lib/server/siws");
  return verifySigned(new Request(`${origin}/api/x`, {
    method: "POST", headers: { "Content-Type": "application/json", origin }, body: JSON.stringify(body),
  }), action);
}

beforeEach(async () => {
  keys ??= await generateKeyPair();
  wallet ??= await getAddressFromPublicKey(keys.publicKey);
  vi.resetModules();
  store.clear();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", origin);
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  vi.stubGlobal("window", {
    location: { origin },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
  });
  rpc.mockReset().mockResolvedValue({ data: true, error: null });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("createSignedRequest signing formats", () => {
  it("keeps a software wallet on raw signing with one prompt", async () => {
    const { createSignedRequest } = await import("@/lib/siws-client");
    const signMessage = softwareWallet();
    const body = await createSignedRequest(session(signMessage), "test.write", { id: "x" });
    expect(body.sigFormat).toBe("raw");
    expect(signMessage).toHaveBeenCalledOnce();
    expect(decode(signMessage.mock.calls[0][0])).toMatch(/^mancipatio:v2:/);
    await expect(serverAccepts(body, "test.write")).resolves.toHaveProperty("wallet", wallet);
  });

  it.each([
    ["offchain-v0", v0Envelope],
    ["offchain-v0-legacy", legacyEnvelope],
  ] as const)("detects a wallet that wraps the message itself (%s), still one prompt", async (format, wrap) => {
    const { createSignedRequest } = await import("@/lib/siws-client");
    const signMessage = wrappingWallet(wrap);
    const body = await createSignedRequest(session(signMessage), "test.write", { display_name: "Rakić" });
    expect(body.sigFormat).toBe(format);
    expect(signMessage).toHaveBeenCalledOnce();
    await expect(serverAccepts(body, "test.write")).resolves.toHaveProperty("wallet", wallet);
  });

  it("retries a Ledger that refuses raw bytes with an off-chain envelope, then remembers it", async () => {
    const { createSignedRequest } = await import("@/lib/siws-client");
    const signMessage = forwardingLedger();
    const first = await createSignedRequest(session(signMessage), "test.write", { id: "1" });
    expect(first.sigFormat).toBe("offchain-v0");
    expect(signMessage).toHaveBeenCalledTimes(2);
    expect(signMessage.mock.calls[1][0][0]).toBe(0xff);
    await expect(serverAccepts(first, "test.write")).resolves.toHaveProperty("wallet", wallet);
    // Later actions (even after a reload) go straight to the envelope: one prompt.
    vi.resetModules();
    const again = await import("@/lib/siws-client");
    const second = await again.createSignedRequest(session(signMessage), "test.write", { id: "2" });
    expect(signMessage).toHaveBeenCalledTimes(3);
    expect(second.sigFormat).toBe("offchain-v0");
    await expect(serverAccepts(second, "test.write")).resolves.toHaveProperty("wallet", wallet);
  });

  it("forgets a remembered Ledger wallet once it stops signing our envelope as-is", async () => {
    store.set("manci:siws-signing:v1", JSON.stringify([wallet]));
    const { createSignedRequest } = await import("@/lib/siws-client");
    // This wallet now wraps whatever it is given — our envelope included.
    const signMessage = wrappingWallet(v0Envelope);
    const stale = await createSignedRequest(session(signMessage), "test.write");
    await expect(serverAccepts(stale, "test.write")).rejects.toMatchObject({ status: 401 });
    expect(JSON.parse(store.get("manci:siws-signing:v1")!)).toEqual([]);
    const next = await createSignedRequest(session(signMessage), "test.write");
    expect(next.sigFormat).toBe("offchain-v0");
    expect(signMessage).toHaveBeenCalledTimes(2);
    await expect(serverAccepts(next, "test.write")).resolves.toHaveProperty("wallet", wallet);
  });

  it.each([
    ["a wallet rejection", Object.assign(new Error("User rejected the request."), { code: 4001 })],
    ["a Ledger denial", new Error("Ledger device: Condition of use not satisfied (denied by the user?) (0x6985)")],
  ])("never re-prompts after %s", async (_label, error) => {
    const { createSignedRequest } = await import("@/lib/siws-client");
    const signMessage = vi.fn(async () => { throw error; });
    await expect(createSignedRequest(session(signMessage), "test.write")).rejects.toBe(error);
    expect(signMessage).toHaveBeenCalledOnce();
  });

  it("does not retry unrelated wallet failures", async () => {
    const { createSignedRequest } = await import("@/lib/siws-client");
    const error = new Error("Wallet popup failed to open");
    const signMessage = vi.fn(async () => { throw error; });
    await expect(createSignedRequest(session(signMessage), "test.write")).rejects.toBe(error);
    expect(signMessage).toHaveBeenCalledOnce();
  });

  it("gives a clear limit error instead of a second prompt when the request is too long for a Ledger", async () => {
    const { createSignedRequest } = await import("@/lib/siws-client");
    const { OffchainMessageLimitError } = await import("@/lib/siws-offchain");
    const signMessage = forwardingLedger();
    const long = { note: "x".repeat(1300) };
    await expect(createSignedRequest(session(signMessage), "test.write", long)).rejects.toBeInstanceOf(OffchainMessageLimitError);
    expect(signMessage).toHaveBeenCalledOnce();
    // A remembered Ledger is not prompted at all for an unsignable request.
    await createSignedRequest(session(signMessage), "test.write", {});
    signMessage.mockClear();
    await expect(createSignedRequest(session(signMessage), "test.write", long)).rejects.toThrow(/too long to sign with a hardware wallet/);
    expect(signMessage).not.toHaveBeenCalled();
  });

  it("explains a Ledger that fails the off-chain retry too", async () => {
    const { createSignedRequest } = await import("@/lib/siws-client");
    const { HardwareWalletSigningError } = await import("@/lib/siws-signing");
    const signMessage = vi.fn(async () => { throw new Error("Ledger: UNKNOWN_ERROR (0x6a81)"); });
    await expect(createSignedRequest(session(signMessage), "test.write")).rejects.toBeInstanceOf(HardwareWalletSigningError);
    expect(signMessage).toHaveBeenCalledTimes(2);
    const { signsOffchainEnvelopes } = await import("@/lib/siws-signing");
    expect(signsOffchainEnvelopes(wallet)).toBe(false);
  });

  it("falls back to 'raw' (the server decides) when the signature matches nothing locally", async () => {
    const { createSignedRequest } = await import("@/lib/siws-client");
    const signMessage = vi.fn(async () => new Uint8Array(64).fill(7));
    const body = await createSignedRequest(session(signMessage), "test.write");
    expect(body.sigFormat).toBe("raw");
    expect(signMessage).toHaveBeenCalledOnce();
    await expect(serverAccepts(body, "test.write")).rejects.toMatchObject({ status: 401 });
  });

  it("shows the hardware-wallet explanations in the account screens", async () => {
    const { accountErrorMessage } = await import("@/lib/account-client");
    const { HardwareWalletSigningError } = await import("@/lib/siws-signing");
    const { OffchainMessageLimitError } = await import("@/lib/siws-offchain");
    expect(accountErrorMessage(new HardwareWalletSigningError(), "fallback")).toMatch(/Solana app on your Ledger/);
    expect(accountErrorMessage(new OffchainMessageLimitError(2000), "fallback")).toMatch(/2000 bytes; the limit is 1212/);
  });

  it("surfaces the hardware-wallet explanation from the per-send wallet policy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: {} })));
    const { requestTransactionWalletPolicy } = await import("@/lib/transaction-wallet-policy");
    const signMessage = vi.fn(async () => { throw new Error("Ledger: blind signing is disabled (0x6808)"); });
    await expect(requestTransactionWalletPolicy(session(signMessage), "devnet", () => {}))
      .rejects.toThrow(/Open the Solana app on your Ledger/);
  });

  it("signs the per-send wallet policy with a remembered Ledger in one prompt", async () => {
    // account.wallets.transaction rides the read session: the one signature
    // is the auth.session exchange, verified here by the real server code.
    const policyFetch = vi.fn(async (path: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      if (path === "/api/auth/session") {
        await serverAccepts(body, "auth.session");
        return Response.json({ ok: true, data: { expires_at: new Date(Date.now() + 3_600_000).toISOString() } });
      }
      expect(body).toMatchObject({ session: true, payload: { action: "account.wallets.transaction" } });
      return Response.json({ ok: true, data: {
        wallet: body.payload.wallet, network: "devnet", account_id: "0b6c3c0e-8f4b-4f7e-9c35-3f1f2b7a9d10", primary_wallet: body.payload.wallet,
      } });
    });
    vi.stubGlobal("fetch", policyFetch);
    store.set("manci:siws-signing:v1", JSON.stringify([wallet]));
    const { requestTransactionWalletPolicy } = await import("@/lib/transaction-wallet-policy");
    const signMessage = forwardingLedger();
    await expect(requestTransactionWalletPolicy(session(signMessage), "devnet", () => {}))
      .resolves.toMatchObject({ wallet, primary_wallet: wallet });
    expect(signMessage).toHaveBeenCalledOnce();
    expect(JSON.parse(policyFetch.mock.calls[0][1]!.body as string).sigFormat).toBe("offchain-v0");
  });
});
