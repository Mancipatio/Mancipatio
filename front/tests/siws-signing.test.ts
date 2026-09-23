// Client half of hardware-wallet SIWS: createSignedRequest picks the format
// (raw / wallet-wrapped off-chain / our own off-chain envelope) with one
// prompt where possible, never sends a signature it has shown the server
// rejects, and the real server verifier accepts what it does send.
// Wallets are simulated with real ed25519 keys; the Ledger simulations follow
// the documented off-chain layouts, built here independently of the app code.
// NOTE: these simulate assumptions (zero application domain, signer list =
// [wallet], error texts); real Phantom/Solflare + Ledger captures belong here
// once the owner's device test has been run.
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
const { rpc, flags } = vi.hoisted(() => ({ rpc: vi.fn(), flags: { noWebCrypto: false } }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({ rpc }) }));
// A browser without WebCrypto Ed25519: the client cannot check signatures.
vi.mock("@solana/kit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/kit")>();
  return {
    ...actual,
    getPublicKeyFromAddress: (...args: Parameters<typeof actual.getPublicKeyFromAddress>) =>
      flags.noWebCrypto ? Promise.reject(new Error("Ed25519 is not supported")) : actual.getPublicKeyFromAddress(...args),
  };
});

const origin = "https://manci.test";
const MODE_KEY = "manci:siws-signing:v1";
const PHANTOM = "wallet-standard:phantom";
const DOMAIN = Buffer.from("\xffsolana offchain", "latin1");
const store = new Map<string, string>();
let keys: CryptoKeyPair;
let wallet: Address;

/** What a Ledger-aware wallet builds when it wraps `text` itself. */
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
const isEnvelope = (bytes: Uint8Array) => bytes[0] === 0xff;

/** Hot wallet: signs exactly the bytes it is given. */
const softwareWallet = () => vi.fn(async (bytes: Uint8Array) => sign(bytes));
/** Ledger-aware wallet that wraps whatever text it is given (our envelope too). */
const wrappingWallet = (wrap: (text: string) => Uint8Array) => vi.fn(async (bytes: Uint8Array) => sign(wrap(decode(bytes))));
/** Wraps plain text itself but passes a ready off-chain message through. */
const wrapOrPassWallet = (wrap: (text: string) => Uint8Array) =>
  vi.fn(async (bytes: Uint8Array) => sign(isEnvelope(bytes) ? bytes : wrap(decode(bytes))));
/** Wallet that forwards bytes to a Ledger: anything but an off-chain message is refused. */
const forwardingLedger = (refusal: unknown = new Error("Ledger device: UNKNOWN_ERROR (0x6a81)")) =>
  vi.fn(async (bytes: Uint8Array) => {
    if (!isEnvelope(bytes)) throw refusal;
    return sign(bytes);
  });
const failing = (error: unknown) => vi.fn(async (bytes: Uint8Array): Promise<Uint8Array> => { void bytes; throw error; });

function session(signMessage: (bytes: Uint8Array) => Promise<Uint8Array>, connectorId = PHANTOM): WalletSession {
  return {
    account: { address: wallet, publicKey: new Uint8Array(32) },
    connector: { id: connectorId, name: connectorId },
    signMessage,
  } as unknown as WalletSession;
}
function remember(connectorId = PHANTOM, expires = Date.now() + 86_400_000) {
  store.set(MODE_KEY, JSON.stringify({ [`${connectorId}|${wallet}`]: expires }));
}
const remembered = () => Object.keys(JSON.parse(store.get(MODE_KEY) ?? "{}"));

async function serverAccepts(body: unknown, action: string) {
  const { verifySigned } = await import("@/lib/server/siws");
  return verifySigned(new Request(`${origin}/api/x`, {
    method: "POST", headers: { "Content-Type": "application/json", origin }, body: JSON.stringify(body),
  }), action);
}
async function events() {
  const { onSigningEvent } = await import("@/lib/siws-signing");
  const seen: string[] = [];
  onSigningEvent((event) => seen.push(event.type));
  return seen;
}

beforeEach(async () => {
  keys ??= await generateKeyPair();
  wallet ??= await getAddressFromPublicKey(keys.publicKey);
  vi.resetModules();
  store.clear();
  flags.noWebCrypto = false;
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
  it("keeps a software wallet on raw signing with one prompt, non-ASCII text included", async () => {
    const { createSignedRequest } = await import("@/lib/siws-client");
    const seen = await events();
    const signMessage = softwareWallet();
    const body = await createSignedRequest(session(signMessage), "test.write", { display_name: "Đorđe Rakić" });
    expect(body.sigFormat).toBe("raw");
    expect(signMessage).toHaveBeenCalledOnce();
    expect(decode(signMessage.mock.calls[0][0])).toMatch(/^mancipatio:v2:.*Đorđe Rakić/);
    expect(seen).toEqual([]);
    await expect(serverAccepts(body, "test.write")).resolves.toHaveProperty("wallet", wallet);
  });

  it.each([
    ["offchain-v0", v0Envelope],
    ["offchain-v0-legacy", legacyEnvelope],
  ] as const)("detects a wallet that wraps ASCII text itself (%s), still one prompt", async (format, wrap) => {
    const { createSignedRequest } = await import("@/lib/siws-client");
    const signMessage = wrappingWallet(wrap);
    const body = await createSignedRequest(session(signMessage), "test.write", { display_name: "Rakic" });
    expect(body.sigFormat).toBe(format);
    expect(signMessage).toHaveBeenCalledOnce();
    await expect(serverAccepts(body, "test.write")).resolves.toHaveProperty("wallet", wallet);
  });

  it.each([
    ["offchain-v0", v0Envelope],
    ["offchain-v0-legacy", legacyEnvelope],
  ] as const)("asks again with the ASCII envelope when a wallet wrapped non-ASCII text as UTF-8 (%s)", async (_format, wrap) => {
    const { createSignedRequest } = await import("@/lib/siws-client");
    const seen = await events();
    const signMessage = wrapOrPassWallet(wrap);
    const body = await createSignedRequest(session(signMessage), "test.write", { display_name: "Rakić" });
    expect(signMessage).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(["envelope-retry"]);
    // The second prompt is the restricted-ASCII envelope: format 0, escaped body.
    const envelope = signMessage.mock.calls[1][0];
    expect(envelope[0]).toBe(0xff);
    expect(envelope[49]).toBe(0);
    expect(decode(envelope)).toContain("Raki\\u0107");
    expect(body.sigFormat).toBe("offchain-v0");
    await expect(serverAccepts(body, "test.write")).resolves.toHaveProperty("wallet", wallet);
    expect(remembered()).toEqual([`${PHANTOM}|${wallet}`]);
  });

  it("refuses non-ASCII text from a wallet that only ever wraps it as UTF-8 (hash-only on a Ledger)", async () => {
    const { createSignedRequest } = await import("@/lib/siws-client");
    const { HardwareWalletSigningError } = await import("@/lib/siws-signing");
    const signMessage = wrappingWallet(v0Envelope); // wraps our envelope again, too
    const error = await createSignedRequest(session(signMessage), "test.write", { display_name: "Rakić" }).catch((e) => e);
    expect(error).toBeInstanceOf(HardwareWalletSigningError);
    expect(error).toMatchObject({ reason: "non_ascii" });
    expect(error.message).toMatch(/only blindly, as a hash/);
    expect(error.message).not.toMatch(/enable blind signing|turn on blind/i);
    expect(signMessage).toHaveBeenCalledTimes(2);
    expect(remembered()).toEqual([]);
  });

  it("retries a Ledger that refuses raw bytes with an off-chain envelope, then remembers it", async () => {
    const { createSignedRequest } = await import("@/lib/siws-client");
    const seen = await events();
    const signMessage = forwardingLedger();
    const first = await createSignedRequest(session(signMessage), "test.write", { id: "1" });
    expect(first.sigFormat).toBe("offchain-v0");
    expect(signMessage).toHaveBeenCalledTimes(2);
    expect(signMessage.mock.calls[1][0][0]).toBe(0xff);
    expect(seen).toEqual(["envelope-retry"]);
    await expect(serverAccepts(first, "test.write")).resolves.toHaveProperty("wallet", wallet);
    // Later actions (even after a reload) go straight to the envelope: one prompt.
    vi.resetModules();
    const again = await import("@/lib/siws-client");
    const second = await again.createSignedRequest(session(signMessage), "test.write", { id: "2" });
    expect(signMessage).toHaveBeenCalledTimes(3);
    expect(second.sigFormat).toBe("offchain-v0");
    await expect(serverAccepts(second, "test.write")).resolves.toHaveProperty("wallet", wallet);
  });

  it("retries a blind-signing refusal (0x6808) with the restricted-ASCII envelope, which needs none", async () => {
    const { createSignedRequest } = await import("@/lib/siws-client");
    const signMessage = forwardingLedger(new Error("Ledger device: Please enable Blind signing (0x6808)"));
    const body = await createSignedRequest(session(signMessage), "test.write", { display_name: "Rakić" });
    expect(signMessage).toHaveBeenCalledTimes(2);
    expect(signMessage.mock.calls[1][0][49]).toBe(0);
    await expect(serverAccepts(body, "test.write")).resolves.toHaveProperty("wallet", wallet);
  });

  it("recognises a Ledger status code carried as a number (TransportStatusError)", async () => {
    const { createSignedRequest } = await import("@/lib/siws-client");
    const refusal = Object.assign(new Error("UNKNOWN_ERROR"), { name: "TransportStatusError", statusCode: 0x6a81 });
    const signMessage = forwardingLedger(refusal);
    await expect(createSignedRequest(session(signMessage), "test.write")).resolves.toHaveProperty("sigFormat", "offchain-v0");
    expect(signMessage).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a software wallet's 'Method not supported'", new Error("Method not supported")],
    ["a wallet's 'unsupported' feature", new Error("signMessage is unsupported for this account")],
    ["a generic -32603 error", Object.assign(new Error("Unexpected error"), { code: -32603 })],
    ["a popup failure", new Error("Wallet popup failed to open")],
    ["a mobile-wallet transport timeout", new Error("Transport closed: request timed out")],
  ])("never retries %s: one prompt, the original error, an offer event", async (_label, error) => {
    const { createSignedRequest } = await import("@/lib/siws-client");
    const seen = await events();
    const signMessage = failing(error);
    await expect(createSignedRequest(session(signMessage), "test.write")).rejects.toBe(error);
    expect(signMessage).toHaveBeenCalledOnce();
    expect(seen).toEqual(["signing-failed"]);
    expect(remembered()).toEqual([]);
  });

  it.each([
    ["locked (0x5515)", new Error("LockedDeviceError: Ledger device: Locked device (0x5515)")],
    ["Solana app not open (0x6e01)", Object.assign(new Error("Ledger device: UNKNOWN_ERROR"), { name: "TransportStatusError", statusCode: 0x6e01 })],
    ["disconnected", new Error("Ledger device disconnected")],
  ])("stops at a transient Ledger state (%s) with an unlock message, no second prompt", async (_label, error) => {
    const { createSignedRequest } = await import("@/lib/siws-client");
    const { HardwareWalletSigningError } = await import("@/lib/siws-signing");
    const seen = await events();
    // A wallet that would wrap a retry again: no retry means no double wrap.
    const signMessage = vi.fn(async (bytes: Uint8Array): Promise<Uint8Array> => {
      if (signMessage.mock.calls.length === 1) throw error;
      return sign(v0Envelope(decode(bytes)));
    });
    const thrown = await createSignedRequest(session(signMessage), "test.write").catch((e) => e);
    expect(thrown).toBeInstanceOf(HardwareWalletSigningError);
    expect(thrown).toMatchObject({ reason: "unavailable" });
    expect(thrown.message).toMatch(/Unlock the Ledger, open the Solana app/);
    expect(signMessage).toHaveBeenCalledOnce();
    expect(seen).toEqual([]);
  });

  it.each([
    ["a wallet rejection", Object.assign(new Error("User rejected the request."), { code: 4001 })],
    ["a Ledger denial", new Error("Ledger device: Condition of use not satisfied (denied by the user?) (0x6985)")],
    ["a device-picker cancel", Object.assign(new Error("Access denied to use Ledger device"), { name: "TransportOpenUserCancelled" })],
  ])("never re-prompts after %s, and reports it as a standard 4001 rejection", async (_label, error) => {
    const { createSignedRequest } = await import("@/lib/siws-client");
    const seen = await events();
    const signMessage = failing(error);
    const thrown = await createSignedRequest(session(signMessage), "test.write").catch((e) => e);
    expect(thrown).toMatchObject({ code: 4001 });
    if ((error as { code?: unknown }).code === 4001) expect(thrown).toBe(error);
    else expect(thrown).toMatchObject({ message: "User rejected the request.", cause: error });
    expect(signMessage).toHaveBeenCalledOnce();
    expect(seen).toEqual([]);
  });

  it("shows an on-device Reject as 'cancelled' on the account and /apply screens", async () => {
    const { createSignedRequest } = await import("@/lib/siws-client");
    const { accountErrorMessage } = await import("@/lib/account-client");
    const { classifyApplicationReadError } = await import("@/lib/apply-read-state");
    const signMessage = failing(new Error("Ledger device: Condition of use not satisfied (denied by the user?) (0x6985)"));
    const thrown = await createSignedRequest(session(signMessage), "test.write").catch((e) => e);
    expect(accountErrorMessage(thrown, "fallback")).toMatch(/signature was cancelled/);
    expect(classifyApplicationReadError(thrown).kind).toBe("signature_rejected");
  });

  it("does not send a signature it has shown the server would reject", async () => {
    const { createSignedRequest } = await import("@/lib/siws-client");
    const { HardwareWalletSigningError } = await import("@/lib/siws-signing");
    const seen = await events();
    const signMessage = vi.fn(async () => new Uint8Array(64).fill(7));
    const thrown = await createSignedRequest(session(signMessage), "test.write").catch((e) => e);
    expect(thrown).toBeInstanceOf(HardwareWalletSigningError);
    expect(thrown).toMatchObject({ reason: "unrecognized" });
    expect(thrown.message).toMatch(/does not recognise, so nothing was sent/);
    expect(signMessage).toHaveBeenCalledOnce();
    expect(seen).toEqual(["signing-failed"]);
  });

  it("without WebCrypto Ed25519 sends 'raw' and the server finds the layout a wallet wrapped itself", async () => {
    flags.noWebCrypto = true;
    const { createSignedRequest } = await import("@/lib/siws-client");
    const signMessage = wrappingWallet(legacyEnvelope);
    const body = await createSignedRequest(session(signMessage), "test.write", { id: "x" });
    expect(body.sigFormat).toBe("raw");
    expect(signMessage).toHaveBeenCalledOnce();
    flags.noWebCrypto = false; // the server has WebCrypto
    await expect(serverAccepts(body, "test.write")).resolves.toHaveProperty("wallet", wallet);
  });

  it("detectSignedFormat tells 'could not check' apart from 'matches nothing'", async () => {
    const { detectSignedFormat } = await import("@/lib/siws-signing");
    const text = 'mancipatio:v2:{"a":1}';
    expect(await detectSignedFormat(await sign(new TextEncoder().encode(text)), text, wallet)).toBe("raw");
    expect(await detectSignedFormat(new Uint8Array(64), text, wallet)).toBe("none");
    expect(await detectSignedFormat(new Uint8Array(64), text, wallet, async () => null)).toBe("unknown");
  });

  it("gives a clear limit error instead of a second prompt when the request is too long for a Ledger", async () => {
    const { createSignedRequest } = await import("@/lib/siws-client");
    const { OffchainMessageLimitError } = await import("@/lib/siws-offchain");
    const signMessage = forwardingLedger();
    const long = { note: "x".repeat(1300) };
    const thrown = await createSignedRequest(session(signMessage), "test.write", long).catch((e) => e);
    expect(thrown).toBeInstanceOf(OffchainMessageLimitError);
    expect(thrown.message).toMatch(/about \d+ characters too long to sign with a hardware wallet/);
    expect(signMessage).toHaveBeenCalledOnce();
    // A remembered Ledger is not prompted at all for an unsignable request,
    // and stays remembered.
    await createSignedRequest(session(signMessage), "test.write", {});
    signMessage.mockClear();
    await expect(createSignedRequest(session(signMessage), "test.write", long)).rejects.toBeInstanceOf(OffchainMessageLimitError);
    expect(signMessage).not.toHaveBeenCalled();
    expect(remembered()).toEqual([`${PHANTOM}|${wallet}`]);
  });

  it("explains a Ledger that fails the off-chain retry too", async () => {
    const { createSignedRequest } = await import("@/lib/siws-client");
    const { HardwareWalletSigningError, signsOffchainEnvelopes } = await import("@/lib/siws-signing");
    const signMessage = failing(new Error("Ledger: UNKNOWN_ERROR (0x6a81)"));
    const thrown = await createSignedRequest(session(signMessage), "test.write").catch((e) => e);
    expect(thrown).toBeInstanceOf(HardwareWalletSigningError);
    expect(thrown).toMatchObject({ reason: "refused" });
    expect(thrown.message).toMatch(/Your Ledger could not sign this request/);
    expect(signMessage).toHaveBeenCalledTimes(2);
    expect(signsOffchainEnvelopes({ connectorId: PHANTOM, wallet })).toBe(false);
  });
});

describe("remembered hardware-wallet mode", () => {
  it("is keyed by wallet app and address: another wallet app starts from raw", async () => {
    remember("wallet-standard:solflare");
    const { createSignedRequest } = await import("@/lib/siws-client");
    const signMessage = softwareWallet();
    const body = await createSignedRequest(session(signMessage, PHANTOM), "test.write");
    expect(body.sigFormat).toBe("raw");
    expect(isEnvelope(signMessage.mock.calls[0][0])).toBe(false);
  });

  it("expires", async () => {
    remember(PHANTOM, Date.now() - 1);
    const { signsOffchainEnvelopes } = await import("@/lib/siws-signing");
    expect(signsOffchainEnvelopes({ connectorId: PHANTOM, wallet })).toBe(false);
  });

  it("forgets a wallet that stops signing our envelope as-is, without sending the bad signature", async () => {
    remember();
    const { createSignedRequest } = await import("@/lib/siws-client");
    const { HardwareWalletSigningError } = await import("@/lib/siws-signing");
    // This wallet now wraps whatever it is given — our envelope included.
    const signMessage = wrappingWallet(v0Envelope);
    const stale = await createSignedRequest(session(signMessage), "test.write").catch((e) => e);
    expect(stale).toBeInstanceOf(HardwareWalletSigningError);
    expect(stale).toMatchObject({ reason: "unrecognized" });
    expect(remembered()).toEqual([]);
    const next = await createSignedRequest(session(signMessage), "test.write");
    expect(next.sigFormat).toBe("offchain-v0");
    expect(signMessage).toHaveBeenCalledTimes(2);
    await expect(serverAccepts(next, "test.write")).resolves.toHaveProperty("wallet", wallet);
  });

  it("recovers from any wallet error: forgets, explains, and the next action starts from raw", async () => {
    remember();
    const { createSignedRequest } = await import("@/lib/siws-client");
    const { HardwareWalletSigningError } = await import("@/lib/siws-signing");
    // e.g. a wallet update that now refuses pre-wrapped 0xff input.
    const signMessage = vi.fn(async (bytes: Uint8Array) => {
      if (isEnvelope(bytes)) throw new Error("Invalid input");
      return sign(bytes);
    });
    const thrown = await createSignedRequest(session(signMessage), "test.write").catch((e) => e);
    expect(thrown).toBeInstanceOf(HardwareWalletSigningError);
    expect(thrown).toMatchObject({ reason: "envelope_refused" });
    expect(thrown.message).toMatch(/switched this wallet back to standard signing/);
    expect(remembered()).toEqual([]);
    const next = await createSignedRequest(session(signMessage), "test.write");
    expect(next.sigFormat).toBe("raw");
    await expect(serverAccepts(next, "test.write")).resolves.toHaveProperty("wallet", wallet);
  });

  it.each([
    ["a locked device", new Error("Ledger device: Locked device (0x5515)"), "unavailable"],
    ["an on-device Reject", new Error("Ledger device: Condition of use not satisfied (denied by the user?) (0x6985)"), undefined],
  ])("keeps the mode after %s", async (_label, error, reason) => {
    remember();
    const { createSignedRequest } = await import("@/lib/siws-client");
    const thrown = await createSignedRequest(session(failing(error)), "test.write").catch((e) => e);
    if (reason) expect(thrown).toMatchObject({ reason });
    else expect(thrown).toMatchObject({ code: 4001 });
    expect(remembered()).toEqual([`${PHANTOM}|${wallet}`]);
  });

  it("can be switched on by hand for a wallet whose Ledger refusal is a generic error, and off again", async () => {
    const { createSignedRequest } = await import("@/lib/siws-client");
    const { onSigningEvent, preferOffchainEnvelope, resetSigningMode, signsOffchainEnvelopes } = await import("@/lib/siws-signing");
    const targets: unknown[] = [];
    onSigningEvent((event) => targets.push(event.target));
    const signMessage = forwardingLedger(Object.assign(new Error("Unexpected error"), { code: -32603 }));
    await expect(createSignedRequest(session(signMessage), "test.write")).rejects.toThrow("Unexpected error");
    expect(targets).toEqual([{ connectorId: PHANTOM, wallet }]);
    // What the notice's "Use hardware-wallet signing" button does:
    preferOffchainEnvelope(targets[0] as { connectorId: string; wallet: string });
    const body = await createSignedRequest(session(signMessage), "test.write");
    expect(body.sigFormat).toBe("offchain-v0");
    expect(signMessage).toHaveBeenCalledTimes(2);
    await expect(serverAccepts(body, "test.write")).resolves.toHaveProperty("wallet", wallet);
    resetSigningMode({ connectorId: PHANTOM, wallet });
    expect(signsOffchainEnvelopes({ connectorId: PHANTOM, wallet })).toBe(false);
  });
});

describe("the retry through the app's session wrappers", () => {
  it("works through guardWalletSession, and a wallet change during the retry is not disguised", async () => {
    const { createSignedRequest } = await import("@/lib/siws-client");
    const { guardWalletSession } = await import("@/lib/guarded-wallet-connectors");
    const source = { ...session(forwardingLedger()), disconnect: async () => {}, onAccountsChanged: () => () => {} } as WalletSession;
    let current: WalletSession | undefined;
    const guarded = guardWalletSession(source, () => current);
    current = guarded;
    const body = await createSignedRequest(guarded, "test.write");
    expect(body.sigFormat).toBe("offchain-v0");
    await expect(serverAccepts(body, "test.write")).resolves.toHaveProperty("wallet", wallet);

    vi.resetModules();
    store.clear();
    const fresh = await import("@/lib/siws-client");
    const guards = await import("@/lib/guarded-wallet-connectors");
    const changing = forwardingLedger();
    const source2 = { ...session(vi.fn(async (bytes: Uint8Array) => {
      const result = await changing(bytes).catch((error) => { current = undefined; throw error; }); // the wallet switches accounts while the first prompt fails
      return result;
    })), disconnect: async () => {}, onAccountsChanged: () => () => {} } as WalletSession;
    const guarded2 = guards.guardWalletSession(source2, () => current);
    current = guarded2;
    const thrown = await fresh.createSignedRequest(guarded2, "test.write").catch((e) => e);
    expect(thrown).toMatchObject({ name: "TransactionWalletChangedError" });
  });

  it("reports both prompts to the /apply signing observer", async () => {
    const { createSignedRequest } = await import("@/lib/siws-client");
    const { withSigningObserver } = await import("@/lib/apply-read-state");
    const phases: string[] = [];
    const observed = withSigningObserver(session(forwardingLedger()), {
      onSignStart: () => phases.push("signing"),
      onSignEnd: () => phases.push("loading"),
    });
    const body = await createSignedRequest(observed, "test.write");
    expect(phases).toEqual(["signing", "loading", "signing", "loading"]);
    await expect(serverAccepts(body, "test.write")).resolves.toHaveProperty("wallet", wallet);
  });
});

describe("hardware-wallet errors on the screens", () => {
  it("shows the hardware-wallet explanations in the account screens and on /apply", async () => {
    const { accountErrorMessage } = await import("@/lib/account-client");
    const { classifyApplicationReadError } = await import("@/lib/apply-read-state");
    const { HardwareWalletSigningError } = await import("@/lib/siws-signing");
    const { OffchainMessageLimitError } = await import("@/lib/siws-offchain");
    const refused = new HardwareWalletSigningError("refused", { cause: new Error("Ledger device: (0x6a81)") });
    const limit = new OffchainMessageLimitError(1300);
    expect(accountErrorMessage(refused, "fallback")).toMatch(/Your Ledger could not sign this request/);
    expect(accountErrorMessage(limit, "fallback")).toMatch(/about 88 characters too long/);
    for (const error of [refused, limit]) {
      expect(classifyApplicationReadError(error)).toMatchObject({ kind: "hardware_wallet", message: error.message });
    }
  });

  it("names the Ledger only when the wallet's error does", async () => {
    const { HardwareWalletSigningError } = await import("@/lib/siws-signing");
    expect(new HardwareWalletSigningError("refused", { cause: new Error("Trezor: invalid message") }).message)
      .toMatch(/^Your wallet could not sign this request/);
    expect(new HardwareWalletSigningError("unavailable").message).toMatch(/hardware wallet is locked/);
  });

  it("surfaces the hardware-wallet explanation from the per-send wallet policy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: {} })));
    const { requestTransactionWalletPolicy } = await import("@/lib/transaction-wallet-policy");
    const signMessage = failing(new Error("Ledger: blind signing is disabled (0x6808)"));
    await expect(requestTransactionWalletPolicy(session(signMessage), "devnet", () => {}))
      .rejects.toThrow(/Your Ledger could not sign this request/);
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
    remember();
    const { requestTransactionWalletPolicy } = await import("@/lib/transaction-wallet-policy");
    const signMessage = forwardingLedger();
    await expect(requestTransactionWalletPolicy(session(signMessage), "devnet", () => {}))
      .resolves.toMatchObject({ wallet, primary_wallet: wallet });
    expect(signMessage).toHaveBeenCalledOnce();
    expect(JSON.parse(policyFetch.mock.calls[0][1]!.body as string).sigFormat).toBe("offchain-v0");
  });
});
