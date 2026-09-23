// Solana off-chain message (v0) SIWS signatures — hardware-wallet path.
// Vectors are built three ways and must agree: by hand from the documented
// layout, by @solana/kit's own envelope compiler, and by lib/siws-offchain.ts.
// The server must accept exactly the byte string the claimed format names.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  address,
  compileOffchainMessageV0Envelope,
  generateKeyPair,
  getAddressEncoder,
  getAddressFromPublicKey,
  getOffchainMessageV0Decoder,
  OffchainMessageContentFormat,
  partiallySignOffchainMessageEnvelope,
  signBytes,
  type Address,
  type OffchainMessageApplicationDomain,
  type OffchainMessageV0,
} from "@solana/kit";
import { siwsMessage, type SiwsPayload, type SiwsRequestBody } from "@/lib/siws-client";
import {
  OFFCHAIN_APPLICATION_DOMAIN,
  OFFCHAIN_MAX_BODY_BYTES,
  OffchainMessageLimitError,
  offchainEnvelopeBytes,
  offchainMessageFormat,
  siwsSignedBytes,
  type SiwsSignatureFormat,
} from "@/lib/siws-offchain";

vi.mock("server-only", () => ({}));
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({ rpc }) }));
import { verifySigned } from "@/lib/server/siws";

const origin = "https://manci.test";
const utf8 = new TextEncoder();
const DOMAIN = Buffer.from("\xffsolana offchain", "latin1");
let keys: CryptoKeyPair;
let wallet: Address;
let otherWallet: Address;

/** The documented layouts, written out independently of lib/siws-offchain.ts. */
function handBuiltV0(text: string, signer: string, format: number, appDomain = new Uint8Array(32)) {
  const body = Buffer.from(text, "utf8");
  return new Uint8Array(Buffer.concat([
    DOMAIN, Buffer.from([0]), Buffer.from(appDomain), Buffer.from([format, 1]),
    Buffer.from(getAddressEncoder().encode(address(signer))),
    Buffer.from([body.length & 0xff, body.length >> 8]), body,
  ]));
}
function handBuiltLegacy(text: string, format: number) {
  const body = Buffer.from(text, "utf8");
  return new Uint8Array(Buffer.concat([DOMAIN, Buffer.from([0, format, body.length & 0xff, body.length >> 8]), body]));
}

function payloadFor(overrides: Partial<SiwsPayload> = {}): SiwsPayload {
  return {
    v: 2, origin, network: "devnet", action: "test.private", wallet,
    nonce: crypto.randomUUID(), ts: new Date().toISOString(),
    params: { client_id: "dossier", amount: "7" }, ...overrides,
  };
}
/** Sign with Kit's own off-chain envelope compiler (not our builder). */
async function kitOffchainSignature(
  text: string,
  options: { applicationDomain?: string; signers?: Address[]; format?: OffchainMessageContentFormat } = {},
) {
  const message = {
    version: 0,
    applicationDomain: (options.applicationDomain ?? OFFCHAIN_APPLICATION_DOMAIN) as OffchainMessageApplicationDomain,
    requiredSignatories: (options.signers ?? [wallet]).map((a) => ({ address: a })),
    content: { format: options.format ?? offchainMessageFormat(text), text },
  } as unknown as OffchainMessageV0;
  const envelope = await partiallySignOffchainMessageEnvelope([keys], compileOffchainMessageV0Envelope(message));
  return envelope.signatures[wallet]!;
}
async function sign(bytes: Uint8Array) {
  return signBytes(keys.privateKey, bytes);
}
function body(payload: SiwsPayload, signature: Uint8Array, sigFormat?: unknown): SiwsRequestBody {
  return {
    payload, publicKey: wallet, signature: Buffer.from(signature).toString("base64"),
    ...(sigFormat === undefined ? {} : { sigFormat: sigFormat as SiwsSignatureFormat }),
  };
}
function request(b: SiwsRequestBody) {
  return new Request(`${origin}/api/private`, {
    method: "POST", headers: { "Content-Type": "application/json", origin }, body: JSON.stringify(b),
  });
}

beforeEach(async () => {
  keys ??= await generateKeyPair();
  wallet ??= await getAddressFromPublicKey(keys.publicKey);
  otherWallet ??= await getAddressFromPublicKey((await generateKeyPair()).publicKey);
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", origin);
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  const consumed = new Set<string>();
  rpc.mockReset();
  rpc.mockImplementation(async (_name, args) => {
    const key = `${args.p_wallet}:${args.p_nonce}`;
    const fresh = !consumed.has(key);
    consumed.add(key);
    return { data: fresh, error: null };
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("off-chain message byte vectors", () => {
  const text = 'mancipatio:v2:{"action":"a","v":2}';

  it("builds the v0 layout byte-for-byte (hand layout = Kit compiler = ours)", () => {
    const ours = offchainEnvelopeBytes(text, wallet, "offchain-v0");
    expect(Buffer.from(ours).toString("hex")).toBe(Buffer.from(handBuiltV0(text, wallet, 0)).toString("hex"));
    const kit = compileOffchainMessageV0Envelope({
      version: 0, applicationDomain: OFFCHAIN_APPLICATION_DOMAIN as OffchainMessageApplicationDomain,
      requiredSignatories: [{ address: wallet }],
      content: { format: OffchainMessageContentFormat.RESTRICTED_ASCII_1232_BYTES_MAX, text },
    } as unknown as OffchainMessageV0);
    expect(Buffer.from(kit.content).equals(Buffer.from(ours))).toBe(true);
    // Fixed preamble: 16 domain + 1 version + 32 app domain + 1 format + 1 count + 32 signer + 2 length.
    expect(ours.length).toBe(85 + text.length);
    expect(ours.subarray(0, 17)).toEqual(Uint8Array.from([...DOMAIN, 0]));
    const decoded = getOffchainMessageV0Decoder().decode(ours);
    expect(decoded.content.text).toBe(text);
    expect(decoded.requiredSignatories).toEqual([{ address: wallet }]);
    expect(decoded.applicationDomain).toBe(OFFCHAIN_APPLICATION_DOMAIN);
  });

  it("builds the legacy solana-sdk v0 layout byte-for-byte", () => {
    const ours = offchainEnvelopeBytes(text, wallet, "offchain-v0-legacy");
    expect(Buffer.from(ours).toString("hex")).toBe(Buffer.from(handBuiltLegacy(text, 0)).toString("hex"));
    expect(Buffer.from(ours.subarray(0, 20)).toString("hex")).toBe(
      "ff736f6c616e61206f6666636861696e" + "00" + "00" + (text.length).toString(16).padStart(2, "0") + "00",
    );
  });

  it("picks the format byte deterministically: printable ASCII = 0, anything else = 1", () => {
    expect(offchainMessageFormat("plain ascii ~")).toBe(0);
    expect(offchainMessageFormat("Rakić")).toBe(1);
    expect(offchainMessageFormat("del\x7f")).toBe(1);
    const unicode = 'mancipatio:v2:{"name":"Đorđe"}';
    expect(offchainEnvelopeBytes(unicode, wallet, "offchain-v0")[49]).toBe(1);
    expect(offchainEnvelopeBytes(unicode, wallet, "offchain-v0-legacy")[17]).toBe(1);
  });

  it("enforces the 1..1212-byte Ledger body limit, counted in UTF-8 bytes", () => {
    const ok = "a".repeat(OFFCHAIN_MAX_BODY_BYTES);
    expect(offchainEnvelopeBytes(ok, wallet, "offchain-v0-legacy")).toHaveLength(20 + OFFCHAIN_MAX_BODY_BYTES);
    expect(offchainEnvelopeBytes(ok, wallet, "offchain-v0")).toHaveLength(85 + OFFCHAIN_MAX_BODY_BYTES);
    for (const layout of ["offchain-v0", "offchain-v0-legacy"] as const) {
      expect(() => offchainEnvelopeBytes(ok + "a", wallet, layout)).toThrow(OffchainMessageLimitError);
      expect(() => offchainEnvelopeBytes("ć".repeat(607), wallet, layout)).toThrow(/1214 bytes; the limit is 1212/);
      expect(() => offchainEnvelopeBytes("", wallet, layout)).toThrow(OffchainMessageLimitError);
    }
    // The raw format has no hardware limit.
    expect(siwsSignedBytes(ok + "a", wallet, "raw")).toEqual(utf8.encode(ok + "a"));
  });

  it("fits every fixed-shape holder action under the Ledger limit, even with a 255-char origin", () => {
    // Worst-case values: 44-char base58 keys, 88-char tx signatures, UUIDs,
    // 64-hex hashes, u64 maxima; origin at the 255-char cap verifySigned allows.
    const W = "B".repeat(44), U = "0b6c3c0e-8f4b-4f7e-9c35-3f1f2b7a9d10", SIG = "5".repeat(88), H = "a".repeat(64);
    const longOrigin = "https://" + "a".repeat(247);
    const actions: [string, Record<string, unknown>][] = [
      ["auth.session", {}],
      ["account.wallets.transaction", {}],
      ["account.update", { display_name: "x".repeat(100), account_id: U }],
      ["account.email.request", { email: "x".repeat(254), account_id: U }],
      ["account.wallets.complete", { token: "x".repeat(43), account_id: U, requested_by: W, target_wallet: W }],
      ["tos.accept", { version: "2026-07-18" }],
      ["launchpad.commit", { sale_pubkey: W, investor_wallet: W, amount: "18446744073709551615", document_terms: { versionId: U, sha256: H } }],
      ["launchpad.recordPurchase", { sale_pubkey: W, investor_wallet: W, settled_tx: SIG, instruction_index: 255 }],
      ["clients.linkWallet", { client_id: U, invitation_hash: H }],
      ["conversion.deposited", { id: U, deposit_tx: SIG }],
      ["delivery.reclaim", { id: U, outcome_tx: SIG }],
      ["vesting-series.mark-created", { id: U, tx: SIG, series_id: "18446744073709551615", series_pda: W, escrow: W }],
    ];
    for (const [action, params] of actions) {
      const text = siwsMessage({ v: 2, origin: longOrigin, network: "localnet", action, wallet: W, ts: new Date(0).toISOString(), nonce: U, params });
      expect(utf8.encode(text).length, action).toBeLessThanOrEqual(OFFCHAIN_MAX_BODY_BYTES);
    }
  });

  it("never produces bytes that could be read as the raw message", () => {
    for (const layout of ["offchain-v0", "offchain-v0-legacy"] as const) {
      expect(offchainEnvelopeBytes(text, wallet, layout)[0]).toBe(0xff);
    }
    expect(siwsSignedBytes(text, wallet, "raw")[0]).toBe("m".charCodeAt(0));
  });
});

describe("server verification of off-chain SIWS signatures", () => {
  it("accepts a Kit-signed v0 envelope over the exact canonical text, once", async () => {
    const payload = payloadFor();
    const b = body(payload, await kitOffchainSignature(siwsMessage(payload)), "offchain-v0");
    await expect(verifySigned(request(b), "test.private")).resolves.toEqual({ wallet, params: payload.params });
    expect(rpc).toHaveBeenCalledTimes(1);
    await expect(verifySigned(request(b), "test.private")).rejects.toMatchObject({ status: 401 });
  });

  it("accepts the legacy solana-sdk layout when the client names it", async () => {
    const payload = payloadFor();
    const b = body(payload, await sign(handBuiltLegacy(siwsMessage(payload), 0)), "offchain-v0-legacy");
    await expect(verifySigned(request(b), "test.private")).resolves.toHaveProperty("wallet", wallet);
  });

  it("accepts UTF-8 (non-ASCII) bodies with format 1 in both layouts", async () => {
    const p1 = payloadFor({ params: { display_name: "Mladen Rakić" } });
    await expect(verifySigned(request(body(p1, await kitOffchainSignature(siwsMessage(p1)), "offchain-v0")), "test.private"))
      .resolves.toHaveProperty("wallet", wallet);
    const p2 = payloadFor({ params: { display_name: "Đorđe" } });
    await expect(verifySigned(request(body(p2, await sign(handBuiltLegacy(siwsMessage(p2), 1)), "offchain-v0-legacy")), "test.private"))
      .resolves.toHaveProperty("wallet", wallet);
  });

  it("rejects a tampered body without touching the nonce store", async () => {
    const payload = payloadFor();
    const signature = await kitOffchainSignature(siwsMessage(payload));
    const altered = { ...payload, params: { ...payload.params, amount: "7000" } };
    await expect(verifySigned(request(body(altered, signature, "offchain-v0")), "test.private")).rejects.toMatchObject({ status: 401 });
    // A signature over an envelope whose body differs from the canonical text.
    const other = await kitOffchainSignature(siwsMessage(payload) + " ");
    await expect(verifySigned(request(body(payload, other, "offchain-v0")), "test.private")).rejects.toMatchObject({ status: 401 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a different application domain, signer list or format byte", async () => {
    const payload = payloadFor();
    const text = siwsMessage(payload);
    const wrongDomain = await kitOffchainSignature(text, { applicationDomain: "So11111111111111111111111111111111111111112" });
    const extraSigner = await kitOffchainSignature(text, { signers: [wallet, otherWallet] });
    const wrongFormat = await kitOffchainSignature(text, { format: OffchainMessageContentFormat.UTF8_1232_BYTES_MAX });
    const legacyWrongFormat = await sign(handBuiltLegacy(text, 1));
    for (const [signature, format] of [
      [wrongDomain, "offchain-v0"], [extraSigner, "offchain-v0"], [wrongFormat, "offchain-v0"],
      [legacyWrongFormat, "offchain-v0-legacy"],
    ] as const) {
      await expect(verifySigned(request(body(payload, signature, format)), "test.private")).rejects.toMatchObject({ status: 401 });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a raw signature presented as off-chain", async () => {
    const payload = payloadFor();
    const raw = await sign(utf8.encode(siwsMessage(payload)));
    for (const format of ["offchain-v0", "offchain-v0-legacy"]) {
      await expect(verifySigned(request(body(payload, raw, format)), "test.private")).rejects.toMatchObject({ status: 401 });
    }
    expect(rpc).not.toHaveBeenCalled();
    await expect(verifySigned(request(body(payload, raw)), "test.private")).resolves.toHaveProperty("wallet", wallet);
  });

  it("rejects an off-chain signature presented as raw or as the other layout", async () => {
    const payload = payloadFor();
    const text = siwsMessage(payload);
    const v0 = await kitOffchainSignature(text);
    const legacy = await sign(handBuiltLegacy(text, 0));
    for (const [signature, format] of [
      [v0, undefined], [v0, "raw"], [v0, "offchain-v0-legacy"],
      [legacy, undefined], [legacy, "raw"], [legacy, "offchain-v0"],
    ] as const) {
      await expect(verifySigned(request(body(payload, signature, format)), "test.private")).rejects.toMatchObject({ status: 401 });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses an over-limit message on the off-chain path with a clear 400, but not on the raw path", async () => {
    const payload = payloadFor({ params: { note: "x".repeat(1200) } });
    const text = siwsMessage(payload);
    expect(utf8.encode(text).length).toBeGreaterThan(OFFCHAIN_MAX_BODY_BYTES);
    // Kit can still encode it (1232-byte cap); our Ledger limit is stricter.
    const signature = await sign(handBuiltLegacy(text, 0));
    const refused = verifySigned(request(body(payload, signature, "offchain-v0-legacy")), "test.private");
    await expect(refused).rejects.toMatchObject({ status: 400 });
    await expect(verifySigned(request(body(payload, signature, "offchain-v0")), "test.private"))
      .rejects.toThrow(/too long to sign with a hardware wallet/);
    expect(rpc).not.toHaveBeenCalled();
    await expect(verifySigned(request(body(payload, await sign(utf8.encode(text)), "raw")), "test.private"))
      .resolves.toHaveProperty("wallet", wallet);
  });

  it.each([["offchain-v1"], ["RAW"], [1], [null], [""]])("rejects the unknown sigFormat %j", async (format) => {
    const payload = payloadFor();
    const raw = await sign(utf8.encode(siwsMessage(payload)));
    await expect(verifySigned(request(body(payload, raw, format)), "test.private")).rejects.toMatchObject({ status: 400 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("keeps every other check: wrong origin, network or expiry still fail before the nonce store", async () => {
    for (const override of [
      { origin: "https://another.test" }, { network: "mainnet" as const },
      { ts: new Date(Date.now() - 400_000).toISOString() },
    ]) {
      const payload = payloadFor(override);
      const signature = await kitOffchainSignature(siwsMessage(payload));
      await expect(verifySigned(request(body(payload, signature, "offchain-v0")), "test.private")).rejects.toMatchObject({ status: 401 });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("issues the same read-session cookie from an off-chain auth.session signature", async () => {
    vi.stubEnv("SESSION_SECRET", "s".repeat(40));
    const { POST } = await import("@/app/api/auth/session/route");
    const payload = payloadFor({ action: "auth.session", params: {} });
    const response = await POST(request(body(payload, await kitOffchainSignature(siwsMessage(payload)), "offchain-v0")));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, data: { wallet, network: "devnet" } });
    expect(response.headers.get("set-cookie")).toMatch(/^manci_session=/);
  });
});
