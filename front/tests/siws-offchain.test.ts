// Solana off-chain message (v0) SIWS signatures — hardware-wallet path.
// Vectors are built three ways and must agree: by hand from the documented
// layout, by @solana/kit's own envelope compiler, and by lib/siws-offchain.ts.
// The server accepts exactly the byte strings it rebuilds from the payload —
// raw text, or a restricted-ASCII (format 0) envelope around the escaped
// text — whichever layout the client names.
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
  offchainBodyLength,
  offchainBodyText,
  offchainEnvelopeBytes,
  siwsSignedBytes,
  utf8WrappedEnvelopeBytes,
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
/** Sign with Kit's own off-chain envelope compiler (not our builder).
 * `text` is the envelope body exactly as given (restricted ASCII by default). */
async function kitOffchainSignature(
  text: string,
  options: { applicationDomain?: string; signers?: Address[]; format?: OffchainMessageContentFormat } = {},
) {
  const message = {
    version: 0,
    applicationDomain: (options.applicationDomain ?? OFFCHAIN_APPLICATION_DOMAIN) as OffchainMessageApplicationDomain,
    requiredSignatories: (options.signers ?? [wallet]).map((a) => ({ address: a })),
    content: { format: options.format ?? OffchainMessageContentFormat.RESTRICTED_ASCII_1232_BYTES_MAX, text },
  } as unknown as OffchainMessageV0;
  const envelope = await partiallySignOffchainMessageEnvelope([keys], compileOffchainMessageV0Envelope(message));
  return envelope.signatures[wallet]!;
}
async function sign(bytes: Uint8Array) {
  return signBytes(keys.privateKey, bytes);
}
/** The accepted v0 signature for a payload: Kit envelope, escaped ASCII body. */
const kitSiws = (payload: SiwsPayload) => kitOffchainSignature(offchainBodyText(siwsMessage(payload)));
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

  it("always uses format 0: non-ASCII characters become JSON \\u escapes in the body", () => {
    const unicode = 'mancipatio:v2:{"name":"Đorđe Rakić"}';
    const escaped = 'mancipatio:v2:{"name":"\\u0110or\\u0111e Raki\\u0107"}';
    expect(offchainBodyText(unicode)).toBe(escaped);
    const v0 = offchainEnvelopeBytes(unicode, wallet, "offchain-v0");
    expect(v0[49]).toBe(0);
    expect(Buffer.from(v0).equals(Buffer.from(handBuiltV0(escaped, wallet, 0)))).toBe(true);
    expect(getOffchainMessageV0Decoder().decode(v0).content).toEqual({ format: 0, text: escaped });
    const legacy = offchainEnvelopeBytes(unicode, wallet, "offchain-v0-legacy");
    expect(legacy[17]).toBe(0);
    expect(Buffer.from(legacy).equals(Buffer.from(handBuiltLegacy(escaped, 0)))).toBe(true);
    // An all-ASCII request is byte-for-byte the canonical text.
    expect(offchainBodyText(text)).toBe(text);
  });

  it("escapes one-to-one: JSON.parse gives back exactly the signed payload", () => {
    const tricky: SiwsPayload[] = [
      payloadFor({ params: { a: "ć", b: "\\u0107", c: "😀", d: "\u007f", e: "\n\t\u0000", f: "\ud800" } }),
      payloadFor({ params: { a: "\\u0107", b: "ć" } }),
      payloadFor({ params: { "ključ": ["đ", { "ž": "é" }], "ć": null } }),
    ];
    const bodies = new Set<string>();
    for (const payload of tricky) {
      const canonical = siwsMessage(payload);
      const body = offchainBodyText(canonical);
      expect(body).toMatch(/^[\x20-\x7e]+$/);
      expect(body.startsWith("mancipatio:v2:")).toBe(true);
      expect(JSON.parse(body.slice("mancipatio:v2:".length))).toEqual(JSON.parse(canonical.slice("mancipatio:v2:".length)));
      expect(JSON.parse(body.slice("mancipatio:v2:".length))).toEqual(JSON.parse(JSON.stringify(payload)));
      bodies.add(body);
    }
    expect(bodies.size).toBe(tricky.length);
    // A literal backslash-u in the text stays distinct from an escaped "ć".
    const [first, second] = tricky.map((p) => offchainBodyText(siwsMessage(p)));
    expect(first).toContain('"a":"\\u0107","b":"\\\\u0107"');
    expect(second).toContain('"a":"\\\\u0107","b":"\\u0107"');
  });

  it("builds the UTF-8 (format 1) envelope only as a client-side diagnostic for non-ASCII text", () => {
    const unicode = 'mancipatio:v2:{"name":"Rakić"}';
    expect(utf8WrappedEnvelopeBytes(text, wallet, "offchain-v0")).toBeNull();
    const v0 = utf8WrappedEnvelopeBytes(unicode, wallet, "offchain-v0")!;
    expect(Buffer.from(v0).equals(Buffer.from(handBuiltV0(unicode, wallet, 1)))).toBe(true);
    const legacy = utf8WrappedEnvelopeBytes(unicode, wallet, "offchain-v0-legacy")!;
    expect(Buffer.from(legacy).equals(Buffer.from(handBuiltLegacy(unicode, 1)))).toBe(true);
  });

  it("enforces the 1..1212-byte Ledger body limit, counted on the escaped body", () => {
    const ok = "a".repeat(OFFCHAIN_MAX_BODY_BYTES);
    expect(offchainEnvelopeBytes(ok, wallet, "offchain-v0-legacy")).toHaveLength(20 + OFFCHAIN_MAX_BODY_BYTES);
    expect(offchainEnvelopeBytes(ok, wallet, "offchain-v0")).toHaveLength(85 + OFFCHAIN_MAX_BODY_BYTES);
    for (const layout of ["offchain-v0", "offchain-v0-legacy"] as const) {
      expect(() => offchainEnvelopeBytes(ok + "a", wallet, layout)).toThrow(OffchainMessageLimitError);
      expect(() => offchainEnvelopeBytes(ok + "a", wallet, layout)).toThrow(/about 1 character too long to sign with a hardware wallet/);
      // Each non-ASCII character costs 6 bytes ("\u0107").
      expect(offchainBodyLength("ć".repeat(202))).toBe(1212);
      expect(offchainEnvelopeBytes("ć".repeat(202), wallet, layout)).toHaveLength((layout === "offchain-v0" ? 85 : 20) + 1212);
      expect(() => offchainEnvelopeBytes("ć".repeat(203), wallet, layout)).toThrow(/about 6 characters too long/);
      expect(() => offchainEnvelopeBytes("", wallet, layout)).toThrow(OffchainMessageLimitError);
    }
    const error = new OffchainMessageLimitError(1300);
    expect(error).toMatchObject({ bytes: 1300, excess: 88 });
    expect(error.message).toMatch(/letters such as ć or đ count as 6 characters each/);
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
      expect(offchainBodyLength(text), action).toBeLessThanOrEqual(OFFCHAIN_MAX_BODY_BYTES);
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
    const b = body(payload, await kitSiws(payload), "offchain-v0");
    await expect(verifySigned(request(b), "test.private")).resolves.toEqual({ wallet, params: payload.params, via: "signature" });
    expect(rpc).toHaveBeenCalledTimes(1);
    await expect(verifySigned(request(b), "test.private")).rejects.toMatchObject({ status: 401 });
  });

  it("accepts the legacy solana-sdk layout when the client names it", async () => {
    const payload = payloadFor();
    const b = body(payload, await sign(handBuiltLegacy(siwsMessage(payload), 0)), "offchain-v0-legacy");
    await expect(verifySigned(request(b), "test.private")).resolves.toHaveProperty("wallet", wallet);
  });

  it("accepts non-ASCII text only as the escaped restricted-ASCII body, never as a UTF-8 (format 1) body", async () => {
    const p1 = payloadFor({ params: { display_name: "Mladen Rakić" } });
    await expect(verifySigned(request(body(p1, await kitSiws(p1), "offchain-v0")), "test.private"))
      .resolves.toHaveProperty("wallet", wallet);
    const p2 = payloadFor({ params: { display_name: "Đorđe" } });
    const legacy = await sign(handBuiltLegacy(offchainBodyText(siwsMessage(p2)), 0));
    await expect(verifySigned(request(body(p2, legacy, "offchain-v0-legacy")), "test.private"))
      .resolves.toHaveProperty("wallet", wallet);
    expect(rpc).toHaveBeenCalledTimes(2);
    rpc.mockClear();
    // A Ledger shows a UTF-8 body only as a hash: refused under every label.
    const p3 = payloadFor({ params: { display_name: "Rakić" } });
    const text = siwsMessage(p3);
    const blind = [
      await kitOffchainSignature(text, { format: OffchainMessageContentFormat.UTF8_1232_BYTES_MAX }),
      await sign(handBuiltLegacy(text, 1)),
      await kitOffchainSignature(offchainBodyText(text), { format: OffchainMessageContentFormat.UTF8_1232_BYTES_MAX }),
    ];
    for (const signature of blind) {
      for (const format of [undefined, "raw", "offchain-v0", "offchain-v0-legacy"]) {
        await expect(verifySigned(request(body(p3, signature, format)), "test.private")).rejects.toMatchObject({ status: 401 });
      }
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a tampered body without touching the nonce store", async () => {
    const payload = payloadFor();
    const signature = await kitSiws(payload);
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

  it("accepts every accepted layout whatever the client names: the label is only a hint", async () => {
    const signers: [string, (text: string) => Promise<Uint8Array>][] = [
      ["raw", (text) => sign(utf8.encode(text))],
      ["offchain-v0", (text) => kitOffchainSignature(offchainBodyText(text))],
      ["offchain-v0-legacy", (text) => sign(handBuiltLegacy(offchainBodyText(text), 0))],
    ];
    for (const [signed, signText] of signers) {
      for (const label of [undefined, "raw", "offchain-v0", "offchain-v0-legacy"]) {
        const payload = payloadFor({ params: { who: "Rakić", signed, label: label ?? "absent" } });
        await expect(verifySigned(request(body(payload, await signText(siwsMessage(payload)), label)), "test.private"))
          .resolves.toHaveProperty("wallet", wallet);
      }
    }
  });

  it("rejects a signature over any other byte string under every label, before the nonce store", async () => {
    const payload = payloadFor();
    const text = siwsMessage(payload);
    const foreign = [
      await kitOffchainSignature(text, { applicationDomain: "So11111111111111111111111111111111111111112" }),
      await sign(utf8.encode(text.slice(0, -1))),
      await sign(handBuiltV0(text, otherWallet, 0)),
    ];
    for (const signature of foreign) {
      for (const label of [undefined, "raw", "offchain-v0", "offchain-v0-legacy"]) {
        await expect(verifySigned(request(body(payload, signature, label)), "test.private")).rejects.toMatchObject({ status: 401 });
      }
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses an over-limit message on the off-chain path with a clear 400, but not on the raw path", async () => {
    const payload = payloadFor({ params: { note: "x".repeat(1200) } });
    const text = siwsMessage(payload);
    expect(utf8.encode(text).length).toBeGreaterThan(OFFCHAIN_MAX_BODY_BYTES);
    // Kit can still encode it (1232-byte cap); our Ledger limit is stricter.
    expect(offchainBodyLength(text)).toBeGreaterThan(OFFCHAIN_MAX_BODY_BYTES);
    const signature = await sign(handBuiltLegacy(text, 0));
    const refused = verifySigned(request(body(payload, signature, "offchain-v0-legacy")), "test.private");
    await expect(refused).rejects.toMatchObject({ status: 400 });
    await expect(verifySigned(request(body(payload, signature, "offchain-v0")), "test.private"))
      .rejects.toThrow(/too long to sign with a hardware wallet/);
    // Labelled raw (or unlabelled), the off-chain layouts are simply skipped.
    await expect(verifySigned(request(body(payload, signature)), "test.private")).rejects.toMatchObject({ status: 401 });
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
      const signature = await kitSiws(payload);
      await expect(verifySigned(request(body(payload, signature, "offchain-v0")), "test.private")).rejects.toMatchObject({ status: 401 });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("issues the same read-session cookie from an off-chain auth.session signature", async () => {
    vi.stubEnv("SESSION_SECRET", "s".repeat(40));
    const { POST } = await import("@/app/api/auth/session/route");
    const payload = payloadFor({ action: "auth.session", params: {} });
    const response = await POST(request(body(payload, await kitSiws(payload), "offchain-v0")));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, data: { wallet, network: "devnet" } });
    expect(response.headers.get("set-cookie")).toMatch(/^manci_session=/);
  });
});
