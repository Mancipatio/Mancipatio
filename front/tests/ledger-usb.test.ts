// "Ledger (USB)" wallet (lib/ledger-usb.ts): a Ledger that signs directly
// over WebHID. The device is tests/helpers/ledger-solana-sim.ts — an
// APDU-level simulation of the Ledger Solana app with real ed25519 keys —
// driven by the real @ledgerhq/hw-app-solana 7.11.0 through the wallet's own
// device wrapper (lib/ledger-usb-webhid.ts solanaAppDevice). The wallet is
// connected through @solana/client's Wallet Standard connector, as in the app,
// and what it signs is checked by the real server verifier (SIWS) and by
// ed25519 verification (transactions).
// NOT covered here: a physical Ledger, WebHID itself, the browser's device
// chooser and the React dialogs.
import { createHash } from "node:crypto";
import Solana from "@ledgerhq/hw-app-solana";
import { createWalletStandardConnector, createWalletTransactionSigner, type WalletSession } from "@solana/client";
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createTransactionMessage,
  getBase58Decoder,
  getPublicKeyFromAddress,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  verifySignature,
  type Address,
  type Blockhash,
} from "@solana/kit";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLedgerUsbWallet,
  findLedgerUsbError,
  LEDGER_DERIVATION_PATHS,
  LEDGER_USB_CONNECTOR_ID,
  ledgerRejection,
  LedgerUsbError,
  ledgerUsbError,
  type LedgerAccountChoiceRequest,
  type LedgerConfirmInfo,
  type LedgerUsbOpen,
  type LedgerUsbPrompts,
} from "@/lib/ledger-usb";
import { solanaAppDevice } from "@/lib/ledger-usb-webhid";
import { accountErrorMessage } from "@/lib/account-client";
import { classifyApplicationReadError } from "@/lib/apply-read-state";
import { inspectTransactionMessage } from "@/scripts/ops/inspect-tx";
import { createSignedRequest, siwsMessage } from "@/lib/siws-client";
import { offchainEnvelopeBytes, OffchainMessageLimitError } from "@/lib/siws-offchain";
import { onSigningEvent, preferOffchainEnvelope, resetSigningMode, signingTarget } from "@/lib/siws-signing";
import { requestTransactionWalletPolicy } from "@/lib/transaction-wallet-policy";
import { explainSendError } from "@/lib/tx-error";
import { SolanaAppSim, simKeys, type SimKey, type SimOptions } from "./helpers/ledger-solana-sim";

vi.mock("server-only", () => ({}));
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseAdmin: () => ({ rpc }) }));
import { verifySigned } from "@/lib/server/siws";

const origin = "https://manci.test";
const STORAGE_KEY = "manci:ledger-usb:v1";
/** A Phantom-style path that is not the first one: the choice must matter. */
const CHOSEN = "44'/501'/2'/0'";
const store = new Map<string, string>();
const storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value); },
  removeItem: (key: string) => { store.delete(key); },
};
let keys: Map<string, SimKey>;
let otherKeys: Map<string, SimKey>;
const chosen = () => keys.get(CHOSEN)!.address as Address;

type Harness = ReturnType<typeof harness>;

/** A wallet whose device is a fresh simulated Ledger on every open. */
function harness(options: SimOptions & { choose?: string } = {}) {
  const device = { keys, options: options as SimOptions };
  const sims: SolanaAppSim[] = [];
  const open = vi.fn<LedgerUsbOpen>(async () => {
    const sim = new SolanaAppSim(device.keys, device.options);
    sims.push(sim);
    return solanaAppDevice(new Solana(sim), sim, Buffer);
  });
  const requests: LedgerAccountChoiceRequest[] = [];
  const confirmations: LedgerConfirmInfo[] = [];
  const prompts = {
    chooseAccount: vi.fn<LedgerUsbPrompts["chooseAccount"]>(async (request) => {
      requests.push(request);
      return request.accounts.find((option) => option.path === (options.choose ?? CHOSEN))!;
    }),
    requestAccess: vi.fn<LedgerUsbPrompts["requestAccess"]>(async (grant) => grant()),
    confirmOnDevice: vi.fn<LedgerUsbPrompts["confirmOnDevice"]>((info) => {
      confirmations.push(info);
      return () => undefined;
    }),
  };
  const wallet = createLedgerUsbWallet({ open, prompts, storage });
  const connector = createWalletStandardConnector(wallet, { id: LEDGER_USB_CONNECTOR_ID, defaultChain: "solana:devnet" });
  const signedApdus = (ins: number) => sims.flatMap((sim) => sim.signed.filter((s) => s.ins === ins));
  const sentApdus = (ins: number) => sims.flatMap((sim) => sim.apdus.filter((a) => a.ins === ins));
  return { wallet, connector, open, prompts, sims, device, requests, confirmations, signedApdus, sentApdus };
}

async function connected(options: SimOptions & { choose?: string } = {}): Promise<Harness & { session: WalletSession }> {
  const h = harness(options);
  const session = await h.connector.connect();
  return { ...h, session };
}

async function serverAccepts(body: unknown, action: string) {
  return verifySigned(new Request(`${origin}/api/x`, {
    method: "POST", headers: { "Content-Type": "application/json", origin }, body: JSON.stringify(body),
  }), action);
}

const sha256base58 = (bytes: Uint8Array) => getBase58Decoder().decode(createHash("sha256").update(bytes).digest());

beforeAll(async () => {
  keys = await simKeys(LEDGER_DERIVATION_PATHS);
  otherKeys = await simKeys(LEDGER_DERIVATION_PATHS);
});

beforeEach(() => {
  store.clear();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", origin);
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
  vi.stubGlobal("window", { location: { origin }, localStorage: storage });
  rpc.mockReset().mockResolvedValue({ data: true, error: null });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Ledger (USB): connecting", () => {
  it("offers the usual derivation paths, as Phantom, Solflare and Ledger Live create them", () => {
    expect(LEDGER_DERIVATION_PATHS).toEqual([
      "44'/501'/0'", "44'/501'/0'/0'", "44'/501'/1'", "44'/501'/1'/0'", "44'/501'/2'", "44'/501'/2'/0'",
      "44'/501'/3'", "44'/501'/3'/0'", "44'/501'/4'", "44'/501'/4'/0'", "44'/501'",
    ]);
  });

  it("reads the address at every path from the device, connects the one picked, and remembers only its path and address", async () => {
    const h = await connected();
    expect(h.open).toHaveBeenCalledExactlyOnceWith({ interactive: true });
    const [request] = h.requests;
    expect(request.accounts).toEqual(LEDGER_DERIVATION_PATHS.map((path) => ({ path, address: keys.get(path)!.address })));
    expect(request.app).toEqual({ version: "1.16.0", blindSigningEnabled: true, signsMessages: true });
    expect(request.remembered).toBeUndefined();
    // Every address comes from GET_ADDR without a display prompt; nothing is signed.
    expect(h.sentApdus(0x05).map((a) => a.p1)).toEqual(LEDGER_DERIVATION_PATHS.map(() => 0));
    expect(h.sims[0].signed).toEqual([]);
    expect(h.sims[0].closed).toBe(1);

    expect(h.session.account.address).toBe(chosen());
    expect(h.session.connector.id).toBe(LEDGER_USB_CONNECTOR_ID);
    expect(h.wallet.accounts.map((a) => [a.address, a.label])).toEqual([[chosen(), `Ledger ${CHOSEN}`]]);
    expect(JSON.parse(store.get(STORAGE_KEY)!)).toEqual({ path: CHOSEN, address: chosen(), auto: true });

    // The next connect (after a disconnect) marks the remembered account.
    await h.session.disconnect();
    await h.connector.connect();
    expect(h.requests[1].remembered).toEqual({ path: CHOSEN, address: chosen() });
  });

  it("shows an address on the device on request: confirmed only when the user approves the same address there", async () => {
    const results: unknown[] = [];
    const reject = new Set<number>();
    const h = harness({ reject });
    h.prompts.chooseAccount.mockImplementation(async (request) => {
      results.push(await request.showOnDevice(CHOSEN));
      reject.add(0x05); // the user rejects the second display on the device
      results.push(await request.showOnDevice(CHOSEN).catch((error) => ledgerUsbError(error)));
      results.push(await request.showOnDevice("m/0'"));
      return request.accounts.find((a) => a.path === CHOSEN)!;
    });
    await h.connector.connect();
    expect(results[0]).toBe(true);
    expect(results[1]).toMatchObject({ code: 4001 });
    expect(results[2]).toBe(false);
    expect(h.sentApdus(0x05).filter((a) => a.p1 === 1)).toHaveLength(2);
  });

  it("reconnects silently after a reload without touching the device, but not after a disconnect", async () => {
    const first = await connected();
    const reload = harness();
    const session = await reload.connector.connect({ autoConnect: true, allowInteractiveFallback: false });
    expect(session.account.address).toBe(chosen());
    expect(reload.open).not.toHaveBeenCalled();

    await first.session.disconnect();
    expect(JSON.parse(store.get(STORAGE_KEY)!)).toEqual({ path: CHOSEN, address: chosen(), auto: false });
    const again = harness();
    await expect(again.connector.connect({ autoConnect: true, allowInteractiveFallback: false })).rejects.toThrow(/no accounts/);
    expect(again.open).not.toHaveBeenCalled();
  });

  it("treats a cancelled picker as a user rejection, and says what to do when the device is locked or the Solana app is closed", async () => {
    const cancelled = harness();
    cancelled.prompts.chooseAccount.mockRejectedValue(ledgerRejection("Connecting the Ledger was cancelled."));
    await expect(cancelled.connector.connect()).rejects.toMatchObject({ code: 4001 });
    expect(cancelled.sims[0].closed).toBe(1);

    const locked = harness({ locked: true });
    const lockedError = await locked.connector.connect().catch((error) => error);
    expect(lockedError).toBeInstanceOf(LedgerUsbError);
    expect(lockedError).toMatchObject({ reason: "locked", message: expect.stringMatching(/locked.*Unlock/) });
    expect(locked.prompts.chooseAccount).not.toHaveBeenCalled();

    const closed = harness({ appClosed: true });
    await expect(closed.connector.connect()).rejects.toMatchObject({ reason: "app_closed", message: expect.stringMatching(/Solana app is not open/) });
    expect(store.has(STORAGE_KEY)).toBe(false);
  });
});

describe("Ledger (USB): SIWS messages", () => {
  it("signs a SIWS request as an offchain-v0 message in one device prompt, and the server accepts it", async () => {
    const h = await connected();
    const events: string[] = [];
    const stop = onSigningEvent((event) => events.push(event.type));
    const body = await createSignedRequest(h.session, "test.write", { display_name: "Đorđe Rakić" });
    stop();
    expect(body.sigFormat).toBe("offchain-v0");
    expect(body.publicKey).toBe(chosen());
    const [signed] = h.signedApdus(0x07);
    expect(h.signedApdus(0x07)).toHaveLength(1);
    expect(signed.path).toBe(CHOSEN);
    // The device received the whole envelope the server rebuilds: domain,
    // version 0, zero application domain, format 0, the account as signer.
    const envelope = offchainEnvelopeBytes(siwsMessage(body.payload), chosen(), "offchain-v0");
    expect(new Uint8Array(signed.message)).toEqual(envelope);
    expect(signed.message.subarray(0, 16).toString("latin1")).toBe("\xffsolana offchain");
    expect([...signed.message.subarray(17, 49)].every((byte) => byte === 0)).toBe(true);
    expect(signed.message[49]).toBe(0);
    expect(signed.message.toString("latin1")).toContain("\\u0110or\\u0111e Raki\\u0107");
    // Longer than one APDU: hw-app-solana chunks it (P2_MORE, then P2_EXTEND).
    expect(h.sentApdus(0x07).map((a) => a.p2)).toEqual([0x02, ...Array(h.sentApdus(0x07).length - 2).fill(0x03), 0x01]);
    expect(h.confirmations).toEqual([{ kind: "message", text: expect.stringMatching(/^mancipatio:v2:\{.*Raki\\u0107/) }]);
    expect(events).toEqual([]);
    await expect(serverAccepts(body, "test.write")).resolves.toMatchObject({ wallet: chosen(), via: "signature" });
  });

  it("passes the per-send wallet check (account.wallets.transaction) end to end", async () => {
    const h = await connected();
    const account = "10000000-0000-4000-8000-000000000001";
    const verified: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit) => {
      // The check is a session read: it first tries to start the wallet
      // session (auth.session); without one here it signs the read itself.
      const action = path === "/api/auth/session" ? "auth.session" : "account.wallets.transaction";
      const { wallet } = await verifySigned(new Request(`${origin}${path}`, {
        method: "POST", headers: { "Content-Type": "application/json", origin }, body: init.body,
      }), action);
      verified.push(action);
      if (action === "auth.session") return Response.json({ ok: false, error: "no session in this test" }, { status: 503 });
      return Response.json({ ok: true, data: { wallet, network: "devnet", account_id: account, primary_wallet: wallet } });
    }));
    await expect(requestTransactionWalletPolicy(h.session, "devnet", () => undefined)).resolves.toMatchObject({ wallet: chosen(), account_id: account });
    expect(verified).toEqual(["auth.session", "account.wallets.transaction"]);
    expect(h.signedApdus(0x07)).toHaveLength(2);
  });

  it("signs a ready envelope (hardware-wallet mode) as-is, and refuses any other envelope before the device", async () => {
    const h = await connected();
    const target = signingTarget(h.session);
    preferOffchainEnvelope(target);
    try {
      const body = await createSignedRequest(h.session, "test.write", { display_name: "Rakic" });
      expect(body.sigFormat).toBe("offchain-v0");
      expect(h.signedApdus(0x07)).toHaveLength(1);
      await expect(serverAccepts(body, "test.write")).resolves.toMatchObject({ wallet: chosen() });
    } finally {
      resetSigningMode(target);
    }

    const text = 'mancipatio:v2:{"action":"test.write"}';
    const withDomain = offchainEnvelopeBytes(text, chosen(), "offchain-v0");
    withDomain[17] = 1; // a non-zero application domain
    const sign = h.wallet.features["solana:signMessage"].signMessage;
    const opens = h.open.mock.calls.length;
    for (const message of [
      offchainEnvelopeBytes(text, keys.get("44'/501'/0'")!.address, "offchain-v0"), // another signer
      offchainEnvelopeBytes(text, chosen(), "offchain-v0-legacy"),
      withDomain,
    ]) {
      await expect(sign({ account: h.wallet.accounts[0], message })).rejects.toMatchObject({ reason: "unsupported_message" });
    }
    expect(h.open.mock.calls.length).toBe(opens);
  });

  it("refuses bytes that are not text, and a request too long for a Ledger, before opening the device", async () => {
    const h = await connected();
    const sign = h.wallet.features["solana:signMessage"].signMessage;
    const account = h.wallet.accounts[0];
    await expect(sign({ account, message: Uint8Array.from([0x6d, 0xc3, 0x28]) })).rejects.toMatchObject({ reason: "unsupported_message" });
    await expect(sign({ account, message: new TextEncoder().encode("x".repeat(1213)) })).rejects.toBeInstanceOf(OffchainMessageLimitError);
    await expect(createSignedRequest(h.session, "test.write", { note: "ć".repeat(200) })).rejects.toBeInstanceOf(OffchainMessageLimitError);
    // A request for another account is refused too.
    await expect(sign({ account: { ...account, address: keys.get("44'/501'/0'")!.address }, message: new TextEncoder().encode("hi") }))
      .rejects.toMatchObject({ reason: "wrong_account" });
    expect(h.open).toHaveBeenCalledOnce(); // the connect
  });

  it("refuses before any signing prompt when the Solana app is too old for this format, and the error reaches the page unchanged", async () => {
    const old = await connected({ version: [1, 7, 2] });
    expect(old.requests[0].app).toEqual({ version: "1.7.2", blindSigningEnabled: true, signsMessages: false });
    const error = await createSignedRequest(old.session, "test.write", {}).catch((e) => e);
    expect(error).toBeInstanceOf(LedgerUsbError);
    expect(error).toMatchObject({ reason: "outdated_app", message: expect.stringMatching(/1\.7\.2.*the latest version \(1\.8\.0 at the very least\)/) });
    expect(old.sentApdus(0x07)).toEqual([]);
    // The per-send wallet check passes it through (not its generic message).
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const policyError = await requestTransactionWalletPolicy(old.session, "devnet", () => undefined).catch((e) => e);
    expect(policyError).toBeInstanceOf(LedgerUsbError);
    expect(policyError).toMatchObject({ reason: "outdated_app" });
    expect(fetch).not.toHaveBeenCalled();

    // A device that reports a new version but parses only the legacy header
    // refuses the format (0x6a81): the advice names its version and "the
    // latest", never "1.8.0 or newer", which it already is.
    const legacy = await connected({ legacyOffchain: true });
    const legacyError = await createSignedRequest(legacy.session, "test.write", {}).catch((e) => e);
    expect(legacyError).toMatchObject({
      reason: "outdated_app", message: expect.stringMatching(/Solana app 1\.16\.0 refused the request format\. Update it to the latest version in Ledger Live/),
    });
    expect(legacyError.message).not.toMatch(/1\.8\.0/);
  });

  it("refuses before the device signs when this browser cannot verify ed25519 signatures", async () => {
    const h = await connected();
    const importKey = vi.spyOn(globalThis.crypto.subtle, "importKey")
      .mockRejectedValue(Object.assign(new Error("Unrecognized name."), { name: "NotSupportedError" }));
    try {
      await expect(createSignedRequest(h.session, "test.write", {})).rejects.toMatchObject({
        name: "LedgerUsbError", reason: "unsupported", message: expect.stringMatching(/cannot check the Ledger's signatures/),
      });
      const transfer = await signTransactionMessageWithSigners(pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(createWalletTransactionSigner(h.session).signer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: getBase58Decoder().decode(new Uint8Array(32).fill(3)) as Blockhash, lastValidBlockHeight: BigInt(1) }, m),
      )).catch((e) => e);
      expect(findLedgerUsbError(transfer)).toMatchObject({ reason: "unsupported" });
    } finally {
      importKey.mockRestore();
    }
    // Nothing reached the device's signing instructions.
    expect(h.sentApdus(0x07)).toEqual([]);
    expect(h.sentApdus(0x06)).toEqual([]);
  });

  it("every account and /apply screen shows the Ledger's own words, not a generic fallback", async () => {
    const h = await connected();
    h.device.options = { locked: true };
    const locked = await createSignedRequest(h.session, "test.write", {}).catch((e) => e);
    expect(locked).toBeInstanceOf(LedgerUsbError);
    expect(accountErrorMessage(locked, "The wallet could not be linked.")).toBe(locked.message);
    expect(accountErrorMessage(locked, "fallback")).toMatch(/Your Ledger is locked/);
    expect(classifyApplicationReadError(locked)).toMatchObject({ kind: "hardware_wallet", message: locked.message });
    // "busy" says "reject any request on the device": still not "the signature was cancelled".
    const busy = ledgerUsbError(Object.assign(new Error("x"), { name: "TransportRaceCondition" }));
    expect(accountErrorMessage(busy, "fallback")).toMatch(/^The Ledger is busy/);
    expect(classifyApplicationReadError(busy)).toMatchObject({ kind: "hardware_wallet", message: expect.stringMatching(/^The Ledger is busy/) });
    // Wrapped (a cause chain) as well.
    expect(accountErrorMessage(new Error("wrapped", { cause: locked }), "fallback")).toBe(locked.message);
    // A rejection on the device stays the standard "cancelled".
    expect(accountErrorMessage(ledgerRejection(), "fallback")).toMatch(/signature was cancelled/);
  });

  it("returns the standard user rejection when the request is rejected on the device, without a second prompt", async () => {
    const h = await connected({ reject: new Set([0x07]) });
    const events: string[] = [];
    const stop = onSigningEvent((event) => events.push(event.type));
    await expect(createSignedRequest(h.session, "test.write", {})).rejects.toMatchObject({ code: 4001 });
    stop();
    expect(h.sentApdus(0x07).filter((a) => !(a.p2 & 0x02))).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it("refuses to sign when the device does not hold the connected account at its path", async () => {
    const h = await connected();
    h.device.keys = otherKeys; // another Ledger (or another passphrase)
    await expect(createSignedRequest(h.session, "test.write", {})).rejects.toMatchObject({
      reason: "wrong_device", message: expect.stringMatching(new RegExp(`not the connected account ${chosen().slice(0, 4)}`)),
    });
    expect(h.sentApdus(0x07)).toEqual([]);
  });

  it("asks for device access when no permitted Ledger is connected; cancelling it is a user rejection", async () => {
    const h = await connected();
    const sim = h.open.getMockImplementation()!;
    h.open.mockImplementation(async (options) => {
      if (!options.interactive) throw new LedgerUsbError("no_access", "No Ledger this site may use is connected.");
      return sim(options);
    });
    const body = await createSignedRequest(h.session, "test.write", {});
    expect(h.prompts.requestAccess).toHaveBeenCalledOnce();
    expect(h.open.mock.calls.slice(-2)).toEqual([[{ interactive: false }], [{ interactive: true }]]);
    await expect(serverAccepts(body, "test.write")).resolves.toMatchObject({ wallet: chosen() });

    h.prompts.requestAccess.mockRejectedValueOnce(ledgerRejection("Connecting the Ledger was cancelled."));
    await expect(createSignedRequest(h.session, "test.write", {})).rejects.toMatchObject({ code: 4001 });
  });
});

describe("Ledger (USB): transactions", () => {
  const blockhash = getBase58Decoder().decode(new Uint8Array(32).fill(7)) as Blockhash;
  const MEMO = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

  function memoMessage(session: WalletSession) {
    const { signer } = createWalletTransactionSigner(session);
    return pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: BigInt(100) }, m),
      (m) => appendTransactionMessageInstruction({
        programAddress: MEMO,
        accounts: [{ address: signer.address, role: AccountRole.READONLY_SIGNER, signer }],
        data: new TextEncoder().encode("manci"),
      }, m),
    );
  }

  it("signs the transaction message on the device; the signature verifies and the page shows the hash the device shows", async () => {
    const h = await connected();
    const signed = await signTransactionMessageWithSigners(memoMessage(h.session));
    const signature = signed.signatures[chosen()];
    expect(signature).toBeTruthy();
    const publicKey = await getPublicKeyFromAddress(chosen());
    await expect(verifySignature(publicKey, signature!, signed.messageBytes)).resolves.toBe(true);
    const [onDevice] = h.signedApdus(0x06);
    expect(onDevice.path).toBe(CHOSEN);
    expect(new Uint8Array(onDevice.message)).toEqual(new Uint8Array(signed.messageBytes));
    const messageBytes = new Uint8Array(signed.messageBytes);
    expect(h.confirmations).toEqual([{ kind: "transaction", hash: sha256base58(messageBytes), message: Buffer.from(messageBytes).toString("base64") }]);
    // The copied message is the independent check: ops:inspect-tx decodes it
    // and prints the hash the device shows, from the bytes alone.
    const [confirmation] = h.confirmations as Extract<LedgerConfirmInfo, { kind: "transaction" }>[];
    const inspected = inspectTransactionMessage(confirmation.message);
    expect(inspected.hash).toBe(sha256base58(new Uint8Array(onDevice.message)));
    expect(inspected.lines).toContain(`  #1 Memo: "manci"`);
  });

  it("says how to turn on blind signing when the Solana app needs it, also through the send error copy", async () => {
    const h = await connected({ needsBlindSigning: true, blindSigningEnabled: false });
    expect(h.requests[0].app.blindSigningEnabled).toBe(false);
    const error = await signTransactionMessageWithSigners(memoMessage(h.session)).catch((e) => e);
    const ledger = findLedgerUsbError(error);
    expect(ledger).toMatchObject({ reason: "blind_signing", message: expect.stringMatching(/Settings → Blind signing → Enabled/) });
    expect(explainSendError(error)).toBe(ledger!.message);
  });

  it("refuses a transaction the connected account does not sign, before the device", async () => {
    const h = await connected();
    const other = keys.get("44'/501'/0'")!.address as Address;
    const transaction = compileTransaction(pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(other, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: BigInt(100) }, m),
    ));
    const sign = h.wallet.features["solana:signTransaction"].signTransaction;
    await expect(sign({ account: h.wallet.accounts[0], transaction: new Uint8Array(getTransactionEncoder().encode(transaction)) }))
      .rejects.toMatchObject({ reason: "not_a_signer" });
    await expect(sign({ account: h.wallet.accounts[0], transaction: Uint8Array.from([1, 2, 3]) }))
      .rejects.toMatchObject({ reason: "unsupported_transaction" });
    expect(h.open).toHaveBeenCalledOnce();
  });
});

describe("Ledger (USB): error mapping", () => {
  const status = (code: number) => Object.assign(new Error(`Ledger device: UNKNOWN_ERROR (0x${code.toString(16)})`), { name: "TransportStatusError", statusCode: code });
  const named = (name: string, message = name) => Object.assign(new Error(message), { name });

  it.each([
    [status(0x6985), { code: 4001 }],
    [status(0x5501), { code: 4001 }],
    [named("NotFoundError", "No device selected."), { code: 4001, message: "No Ledger was selected." }],
    [status(0x5515), { reason: "locked" }],
    [status(0x6982), { reason: "locked" }],
    [named("LockedDeviceError", "Ledger device: Locked device (0x5515)"), { reason: "locked" }],
    [status(0x6e00), { reason: "app_closed" }],
    [status(0x6e01), { reason: "app_closed" }],
    [status(0x6d00), { reason: "app_closed" }],
    [status(0x6511), { reason: "app_closed" }],
    [new Error("Missing a parameter. Try enabling blind signature in the app"), { reason: "blind_signing" }],
    [status(0x6a81), { reason: "outdated_app" }],
    [named("SecurityError", "Must be handling a user gesture to show a permission request."), { reason: "no_access" }],
    [named("DisconnectedDeviceDuringOperation"), { reason: "disconnected" }],
    [named("TransportRaceCondition"), { reason: "busy" }],
    [named("TransportError", "Ledger Device is busy (lock getAddress)"), { reason: "busy" }],
    [named("NotAllowedError", "Failed to open the device."), { reason: "busy" }],
    [new Error("weird"), { reason: "failed", message: expect.stringContaining("(weird)") }],
  ] as const)("maps %s", (error, expected) => {
    expect(ledgerUsbError(error)).toMatchObject(expected);
  });

  it("names the transaction case for a transaction the app cannot parse", () => {
    expect(ledgerUsbError(Object.assign(new Error("x"), { statusCode: 0x6a80 }), "transaction")).toMatchObject({ reason: "unsupported_transaction" });
  });

  it("a refused message format names the app version, and says 1.8.0 only to an app older than that", () => {
    for (const code of [0x6a80, 0x6a81, 0x6a82, 0x6a83]) {
      const newer = ledgerUsbError(status(code), "message", "1.9.0") as LedgerUsbError;
      expect(newer).toMatchObject({ reason: "outdated_app", message: expect.stringMatching(/Solana app 1\.9\.0 refused.*Update it to the latest version in Ledger Live/) });
      expect(newer.message).not.toMatch(/1\.8\.0/);
    }
    expect(ledgerUsbError(status(0x6a81), "message", "1.7.2")).toMatchObject({ message: expect.stringMatching(/Solana app 1\.7\.2 refused.*latest version \(1\.8\.0 at the very least\)/) });
    expect(ledgerUsbError(status(0x6a81))).toMatchObject({ reason: "outdated_app", message: expect.stringMatching(/^The Ledger's Solana app refused.*latest version in Ledger Live/) });
  });
});
