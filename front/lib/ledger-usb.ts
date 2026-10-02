// "Ledger (USB)" — a Wallet Standard wallet that signs directly on a Ledger
// over WebHID (Chrome, Edge). Browser glue: lib/ledger-usb-webhid.ts (the
// device), lib/ledger-usb-prompts.ts + components/ledger-usb-dialogs.tsx (the
// account picker and the "confirm on your Ledger" notices),
// lib/ledger-usb-connector.ts (the connector in app/providers.tsx).
//
// Why: Phantom, Solflare and Jupiter with a Ledger do not sign off-chain
// messages (Ledger support, "Unable to sign off-chain messages with Ledger
// Solana wallet created in third-party wallets"; supabase/auth#2277), and
// @solana/wallet-adapter-ledger 0.9.30 has no signMessage. Every Manci
// transaction is preceded by a SIWS check (lib/transaction-wallet-policy.ts),
// so a role held on such a Ledger could not act at all.
//
// Messages (solana:signMessage): the SIWS text is wrapped in the
// "offchain-v0" envelope by the builder the server rebuilds it with
// (lib/siws-offchain.ts: application domain zero, format 0 = restricted ASCII
// with non-ASCII \u-escaped, signer = this account, body ≤ 1212 bytes) and
// signed with the Solana app's SIGN OFFCHAIN MESSAGE (INS 0x07). The app takes
// the WHOLE envelope ("\xffsolana offchain" included), shows its text and signs
// exactly those bytes (LedgerHQ/app-solana handle_sign_offchain_message.c,
// set_result_sign_message). The output's signedMessage is that envelope (the
// Wallet Standard lets a wallet change what it signs), and
// lib/siws-signing.ts finds the signature valid over its offchain-v0 bytes:
// one prompt. A ready envelope (lib/siws-signing.ts hardware-wallet mode) is
// signed as-is only when it is byte-for-byte the one the builder makes for
// this account; bytes that are not UTF-8 text are refused.
// This layout (with application domain and signers) needs Solana app 1.8.0 or
// newer: Ledger Live's own threshold (legacyOCMSMaxVersion "1.8.0"); older
// apps know only the legacy header and are refused before any prompt.
//
// Transactions (solana:signTransaction): the device signs the transaction
// message (INS 0x06). Instructions of Manci's programs need "Blind signing"
// in the Solana app; the device then shows the message hash, and the page
// shows base58(SHA-256(message)) to compare (as chain:emergency does).
//
// Accounts: an address created in Phantom or Solflare does not record its
// derivation path, so connecting reads the addresses at the usual paths
// (44'/501'/i' and 44'/501'/i'/0' for i = 0..4, and 44'/501') and the user
// picks theirs. The choice (path + address, nothing else) is remembered in
// localStorage for the silent reconnect after a reload, which does not touch
// the device. Every signature first checks that the device still has that
// address at that path, and is verified against it before it is returned.
//
// Device access is serialized, and the device is closed after each operation
// so Ledger Live or another tab can use it in between.

import type { IdentifierString, Wallet, WalletAccount, WalletIcon } from "@wallet-standard/base";
import type {
  StandardConnectFeature,
  StandardConnectInput,
  StandardDisconnectFeature,
  StandardEventsFeature,
  StandardEventsListeners,
  StandardEventsNames,
} from "@wallet-standard/features";
import type {
  SolanaSignMessageFeature,
  SolanaSignMessageInput,
  SolanaSignMessageOutput,
  SolanaSignTransactionFeature,
  SolanaSignTransactionInput,
  SolanaSignTransactionOutput,
} from "@solana/wallet-standard-features";
import {
  address,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  getTransactionEncoder,
  isAddress,
  signatureBytes,
  verifySignature,
  type Address,
  type SignatureBytes,
  type Transaction,
} from "@solana/kit";
import {
  isRestrictedAscii,
  OFFCHAIN_SIGNING_DOMAIN,
  offchainBodyText,
  offchainEnvelopeBytes,
  OffchainMessageLimitError,
} from "@/lib/siws-offchain";

export const LEDGER_USB_WALLET_NAME = "Ledger (USB)";
/** Stable connector id (persisted by @solana/client for the silent reconnect). */
export const LEDGER_USB_CONNECTOR_ID = "wallet-standard:ledger-usb";

/** Derivation paths offered when connecting, in this order. */
export const LEDGER_DERIVATION_PATHS: readonly string[] = Object.freeze([
  ...[0, 1, 2, 3, 4].flatMap((i) => [`44'/501'/${i}'`, `44'/501'/${i}'/0'`]),
  "44'/501'",
]);

/** Oldest Solana app version that signs the "offchain-v0" layout. */
export const MIN_OFFCHAIN_APP_VERSION = "1.8.0";

/** Bytes before the body of a one-signer "offchain-v0" envelope. */
const V0_HEADER_BYTES = OFFCHAIN_SIGNING_DOMAIN.length + 1 + 32 + 1 + 1 + 32 + 2;

const SOLANA_CHAINS: readonly IdentifierString[] = Object.freeze([
  "solana:mainnet", "solana:devnet", "solana:testnet", "solana:localnet",
]);
const ACCOUNT_FEATURES: readonly IdentifierString[] = Object.freeze(["solana:signMessage", "solana:signTransaction"]);

/** A generic hardware-key glyph (not a vendor logo). */
const ICON: WalletIcon = `data:image/svg+xml;base64,${btoa(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#1f2a24"/>' +
    '<rect x="7" y="11" width="18" height="10" rx="2" fill="none" stroke="#e8efe9" stroke-width="2"/>' +
    '<rect x="25" y="14" width="3" height="4" fill="#e8efe9"/><circle cx="12" cy="16" r="2" fill="#e8efe9"/></svg>',
)}`;

// ── Device ───────────────────────────────────────────────────────────────────

/** The Ledger Solana app calls this wallet makes (@ledgerhq/hw-app-solana 7.11.0). */
export type LedgerUsbDevice = {
  /** The 32-byte public key at `path`; `display` asks the device to show it for confirmation. */
  getAddress(path: string, display?: boolean): Promise<Uint8Array>;
  getAppConfiguration(): Promise<{ version: string; blindSigningEnabled: boolean }>;
  /** Signs a whole serialized off-chain message (INS 0x07). */
  signOffchainMessage(path: string, message: Uint8Array): Promise<Uint8Array>;
  /** Signs a serialized transaction message (INS 0x06). */
  signTransaction(path: string, message: Uint8Array): Promise<Uint8Array>;
  close(): Promise<void>;
};

/** `interactive` may show the browser's device chooser (it needs a user gesture);
 * otherwise only an already permitted, connected Ledger is opened, or
 * LedgerUsbError "no_access" is thrown. */
export type LedgerUsbOpen = (options: { interactive: boolean }) => Promise<LedgerUsbDevice>;

// ── Prompts (components/ledger-usb-dialogs.tsx) ──────────────────────────────

export type LedgerAppInfo = { version: string; blindSigningEnabled: boolean; signsMessages: boolean };
export type LedgerAccountOption = { path: string; address: string };
export type LedgerAccountChoiceRequest = {
  /** Every address read from the device, one per LEDGER_DERIVATION_PATHS entry. */
  accounts: readonly LedgerAccountOption[];
  app: LedgerAppInfo;
  /** The remembered choice, when this device still has it. */
  remembered?: LedgerAccountOption;
  /** Shows the address at `path` on the device; true when the user approved
   * there and it equals the listed one. */
  showOnDevice(path: string): Promise<boolean>;
};
export type LedgerConfirmInfo =
  | { kind: "message"; text: string }
  | { kind: "transaction"; hash: string | null };

export type LedgerUsbPrompts = {
  /** Resolves with the account the user picked; rejects (code 4001) when cancelled. */
  chooseAccount(request: LedgerAccountChoiceRequest): Promise<LedgerAccountOption>;
  /** No permitted Ledger is connected: ask the user to connect it and click
   * (a user gesture), then run `grant`. Rejects (code 4001) when cancelled. */
  requestAccess(grant: () => Promise<LedgerUsbDevice>): Promise<LedgerUsbDevice>;
  /** The device now shows a request; returns the function that hides the notice. */
  confirmOnDevice(info: LedgerConfirmInfo): () => void;
};

/** What localStorage keeps: the chosen path and address only. */
export type LedgerUsbStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// ── Errors ───────────────────────────────────────────────────────────────────

export type LedgerUsbFailure =
  | "unsupported" // no WebHID in this browser
  | "no_access" // no permitted Ledger connected (needs the device chooser)
  | "locked"
  | "app_closed" // dashboard or another app open
  | "outdated_app"
  | "blind_signing"
  | "busy" // in use by Ledger Live / another tab, or a request is still open
  | "disconnected"
  | "wrong_device" // the device does not hold the connected account at its path
  | "not_connected"
  | "wrong_account"
  | "unsupported_message"
  | "unsupported_transaction"
  | "not_a_signer"
  | "bad_signature"
  | "failed";

/** A Ledger (USB) failure, worded for the user. lib/siws-signing.ts,
 * lib/transaction-wallet-policy.ts and lib/tx-error.ts show it as-is. */
export class LedgerUsbError extends Error {
  constructor(readonly reason: LedgerUsbFailure, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LedgerUsbError";
  }
}

/** The standard "user rejected" shape (code 4001) every screen shows as cancelled. */
export function ledgerRejection(message = "The request was rejected on the Ledger.", cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code: 4001 });
}

/** The LedgerUsbError in an error's cause chain, if any. */
export function findLedgerUsbError(error: unknown): LedgerUsbError | null {
  for (let cursor = error, depth = 0; cursor && typeof cursor === "object" && depth < 8; depth++) {
    if (cursor instanceof LedgerUsbError || (cursor as { name?: unknown }).name === "LedgerUsbError") return cursor as LedgerUsbError;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return null;
}

function isRejection(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { code?: unknown }).code === 4001;
}

/** The APDU status of a @ledgerhq error (TransportStatusError.statusCode, or "(0x6985)" in its text). */
function statusOf(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { statusCode?: unknown }).statusCode;
  if (typeof code === "number") return code;
  const match = /\(0x([0-9a-f]{4})\)/i.exec(String((error as { message?: unknown }).message ?? ""));
  return match ? parseInt(match[1], 16) : null;
}

const UNLOCK = "Unlock the Ledger, open the Solana app, then try again.";

/** Maps a transport / Ledger app / browser error to what the user can do. */
export function ledgerUsbError(error: unknown, during: "connect" | "message" | "transaction" = "connect"): unknown {
  if (error instanceof LedgerUsbError || error instanceof OffchainMessageLimitError || isRejection(error)) return error;
  const name = error && typeof error === "object" ? String((error as { name?: unknown }).name ?? "") : "";
  const text = error instanceof Error ? error.message : String(error ?? "");
  const status = statusOf(error);
  if (status === 0x6985 || status === 0x5501 || name === "UserRefusedOnDevice") return ledgerRejection(undefined, error);
  if (name === "TransportOpenUserCancelled" || name === "NotFoundError") {
    return ledgerRejection("No Ledger was selected.", error);
  }
  if (status === 0x5515 || status === 0x6982 || name === "LockedDeviceError" || /locked device/i.test(text)) {
    return new LedgerUsbError("locked", `Your Ledger is locked. ${UNLOCK}`, { cause: error });
  }
  if (status !== null && (status >> 8 === 0x6e || status >> 8 === 0x6d || status === 0x6511 || status === 0x650f)) {
    return new LedgerUsbError("app_closed", `The Solana app is not open on your Ledger. ${UNLOCK}`, { cause: error });
  }
  if (status === 0x6808 || /blind sign/i.test(text)) {
    return new LedgerUsbError(
      "blind_signing",
      "Blind signing is off in the Ledger's Solana app, and Manci transactions need it. On the Ledger open the Solana app → Settings → Blind signing → Enabled, then try again, and approve only if the hash on the device matches the one Manci shows.",
      { cause: error },
    );
  }
  if (status !== null && status >= 0x6a80 && status <= 0x6a83) {
    return during === "transaction"
      ? new LedgerUsbError("unsupported_transaction", "The Ledger's Solana app could not read this transaction. Update the Solana app (Ledger Live → My Ledger), then try again.", { cause: error })
      : new LedgerUsbError("outdated_app", `The Ledger's Solana app refused the request format. Update the Solana app to ${MIN_OFFCHAIN_APP_VERSION} or newer (Ledger Live → My Ledger), then try again.`, { cause: error });
  }
  if (name === "SecurityError") {
    // The device chooser was asked for without a recent click.
    return new LedgerUsbError("no_access", "The browser needs a click before it lets Manci choose a Ledger.", { cause: error });
  }
  if (/disconnected/i.test(name) || /disconnected|device was lost/i.test(text)) {
    return new LedgerUsbError("disconnected", "The Ledger was disconnected. Plug it in and unlock it, open the Solana app, then try again.", { cause: error });
  }
  if (name === "TransportRaceCondition" || name === "InvalidStateError" || name === "NotAllowedError" ||
      /failed to open the device|already open|device is busy/i.test(text)) {
    return new LedgerUsbError("busy", "The Ledger is busy: close Ledger Live or any other tab using it, finish or reject any request on the device, then try again.", { cause: error });
  }
  return new LedgerUsbError("failed", `The Ledger could not complete the request${text ? ` (${text})` : ""}. ${UNLOCK}`, { cause: error });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** "1.8.0" ≤ version, for "x.y.z". An unreadable version is left to the device. */
export function signsOffchainV0(version: string): boolean {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim())?.slice(1).map(Number) ?? null;
  const have = parse(version);
  const need = parse(MIN_OFFCHAIN_APP_VERSION)!;
  if (!have) return true;
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i] > need[i];
  return true;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);
const startsWith = (bytes: Uint8Array, prefix: Uint8Array) =>
  bytes.length >= prefix.length && prefix.every((byte, i) => bytes[i] === byte);
const short = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;

/**
 * The envelope the device signs for a solana:signMessage request, and the
 * text it shows. Raw bytes must be UTF-8 text: the shared builder wraps them
 * (non-ASCII \u-escaped, so the body is restricted ASCII; over 1212 bytes →
 * OffchainMessageLimitError). A ready envelope passes only when it is
 * exactly what the builder makes for `wallet`.
 */
export function ledgerMessageEnvelope(message: Uint8Array, wallet: string): { envelope: Uint8Array; text: string } {
  if (startsWith(message, OFFCHAIN_SIGNING_DOMAIN)) {
    const text = String.fromCharCode(...message.subarray(V0_HEADER_BYTES));
    let rebuilt: Uint8Array | null = null;
    if (isRestrictedAscii(text)) {
      try {
        rebuilt = offchainEnvelopeBytes(text, wallet, "offchain-v0");
      } catch (error) {
        if (error instanceof OffchainMessageLimitError) throw error;
      }
    }
    if (!rebuilt || !sameBytes(rebuilt, message)) {
      throw new LedgerUsbError(
        "unsupported_message",
        "The Ledger (USB) wallet signs off-chain messages only in Manci's format, for the connected account. Nothing was signed.",
      );
    }
    return { envelope: message, text };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(message);
  } catch {
    throw new LedgerUsbError("unsupported_message", "The Ledger (USB) wallet signs text messages only. Nothing was signed.");
  }
  return { envelope: offchainEnvelopeBytes(text, wallet, "offchain-v0"), text: offchainBodyText(text) };
}

/** base58(SHA-256(message)): the hash the Solana app shows when it blind-signs. */
export async function ledgerMessageHash(message: Uint8Array): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(message));
    return getBase58Decoder().decode(new Uint8Array(digest));
  } catch {
    return null;
  }
}

/** Throws unless `signature` is `wallet`'s ed25519 signature over `bytes`
 * (skipped where this browser has no WebCrypto Ed25519). */
async function assertSignature(signature: Uint8Array, bytes: Uint8Array, wallet: string): Promise<void> {
  const bad = () => new LedgerUsbError("bad_signature", "The Ledger returned a signature that does not match the connected account and this request. Nothing was sent.");
  if (signature.length !== 64) throw bad();
  let verified: boolean;
  try {
    verified = await verifySignature(await getPublicKeyFromAddress(address(wallet)), signatureBytes(signature), bytes);
  } catch {
    return;
  }
  if (!verified) throw bad();
}

const STORAGE_KEY = "manci:ledger-usb:v1";
type Saved = LedgerAccountOption & { auto: boolean };

function readSaved(storage: LedgerUsbStorage | null): Saved | null {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== "object") return null;
    const { path, address: saved, auto } = value as Record<string, unknown>;
    if (typeof path !== "string" || !LEDGER_DERIVATION_PATHS.includes(path) || typeof saved !== "string" || !isAddress(saved)) return null;
    return { path, address: saved, auto: auto === true };
  } catch {
    return null;
  }
}

function writeSaved(storage: LedgerUsbStorage | null, saved: Saved) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify({ path: saved.path, address: saved.address, auto: saved.auto }));
  } catch { /* storage blocked: the choice lasts for this page only */ }
}

// ── The wallet ───────────────────────────────────────────────────────────────

export type LedgerUsbWalletFeatures = StandardConnectFeature & StandardDisconnectFeature & StandardEventsFeature &
  SolanaSignMessageFeature & SolanaSignTransactionFeature;

export type LedgerUsbWalletDeps = {
  open: LedgerUsbOpen;
  prompts: LedgerUsbPrompts;
  storage: LedgerUsbStorage | null;
};

type Connected = { path: string; address: Address; account: WalletAccount };

export function createLedgerUsbWallet(deps: LedgerUsbWalletDeps): Wallet & { readonly features: LedgerUsbWalletFeatures } {
  const { open, prompts, storage } = deps;
  let connected: Connected | null = null;
  const listeners = new Set<StandardEventsListeners["change"]>();
  let queue: Promise<unknown> = Promise.resolve();

  /** One device operation at a time (the Ledger answers one APDU exchange at a time). */
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  function emitChange() {
    const accounts = connected ? [connected.account] : [];
    for (const listener of [...listeners]) {
      try { listener({ accounts }); } catch { /* a listener must not break the wallet */ }
    }
  }

  function connect(path: string, wallet: string) {
    const account: WalletAccount = Object.freeze({
      address: wallet,
      publicKey: getAddressEncoder().encode(address(wallet)),
      chains: SOLANA_CHAINS,
      features: ACCOUNT_FEATURES,
      label: `Ledger ${path}`,
    });
    connected = { path, address: address(wallet), account };
    emitChange();
    return account;
  }

  async function openDevice(interactive: boolean, during: "connect" | "message" | "transaction"): Promise<LedgerUsbDevice> {
    try {
      return await open({ interactive });
    } catch (error) {
      const mapped = ledgerUsbError(error, during);
      if (!(mapped instanceof LedgerUsbError && mapped.reason === "no_access")) throw mapped;
    }
    try {
      return await prompts.requestAccess(() => open({ interactive: true }));
    } catch (error) {
      throw ledgerUsbError(error, during);
    }
  }

  async function readAppInfo(device: LedgerUsbDevice): Promise<LedgerAppInfo> {
    const { version, blindSigningEnabled } = await device.getAppConfiguration();
    return { version, blindSigningEnabled, signsMessages: signsOffchainV0(version) };
  }

  const readAddress = async (device: LedgerUsbDevice, path: string, display = false) => {
    const key = await device.getAddress(path, display);
    if (key.length !== 32) throw new LedgerUsbError("failed", "The Ledger returned a malformed public key.");
    return getAddressDecoder().decode(key);
  };

  /** Opens the device for the connected account, checks it still holds that
   * account at its path, runs `task`, closes the device. */
  function withAccount<T>(during: "message" | "transaction", task: (device: LedgerUsbDevice, account: Connected) => Promise<T>): Promise<T> {
    return exclusive(async () => {
      const account = connected;
      if (!account) throw new LedgerUsbError("not_connected", "Connect the Ledger (USB) wallet first.");
      const device = await openDevice(false, during);
      try {
        const found = await readAddress(device, account.path);
        if (found !== account.address) {
          throw new LedgerUsbError(
            "wrong_device",
            `This Ledger has ${short(found)} at ${account.path}, not the connected account ${short(account.address)}. ` +
              "Connect the Ledger that holds this account, or disconnect and pick the account again.",
          );
        }
        if (connected !== account) throw new LedgerUsbError("not_connected", "The Ledger (USB) wallet was disconnected. Nothing was signed.");
        return await task(device, account);
      } catch (error) {
        throw ledgerUsbError(error, during);
      } finally {
        await device.close().catch(() => undefined);
      }
    });
  }

  function requireAccount(input: { account: WalletAccount }): Connected {
    if (!connected) throw new LedgerUsbError("not_connected", "Connect the Ledger (USB) wallet first.");
    if (input.account.address !== connected.address) {
      throw new LedgerUsbError("wrong_account", "This request is for another account than the connected Ledger account. Nothing was signed.");
    }
    return connected;
  }

  const features: LedgerUsbWalletFeatures = {
    "standard:connect": {
      version: "1.0.0",
      async connect(input?: StandardConnectInput) {
        if (connected) return { accounts: [connected.account] };
        if (input?.silent) {
          // Reconnect after a reload without touching the device: the first
          // signature checks the device (withAccount).
          const saved = readSaved(storage);
          return { accounts: saved?.auto ? [connect(saved.path, saved.address)] : [] };
        }
        return exclusive(async () => {
          // The first await: the device chooser needs the click's user activation.
          const device = await openDevice(true, "connect");
          try {
            const app = await readAppInfo(device);
            const accounts: LedgerAccountOption[] = [];
            for (const path of LEDGER_DERIVATION_PATHS) accounts.push({ path, address: await readAddress(device, path) });
            const saved = readSaved(storage);
            const remembered = saved ? accounts.find((a) => a.path === saved.path && a.address === saved.address) : undefined;
            let showing = false;
            const choice = await prompts.chooseAccount({
              accounts,
              app,
              remembered,
              async showOnDevice(path) {
                const listed = accounts.find((a) => a.path === path);
                if (!listed || showing) return false;
                showing = true;
                try {
                  return (await readAddress(device, path, true)) === listed.address;
                } finally {
                  showing = false;
                }
              },
            });
            const picked = accounts.find((a) => a.path === choice.path && a.address === choice.address);
            if (!picked) throw new LedgerUsbError("failed", "The chosen account is not on this Ledger. Connect again.");
            writeSaved(storage, { ...picked, auto: true });
            return { accounts: [connect(picked.path, picked.address)] };
          } catch (error) {
            throw ledgerUsbError(error, "connect");
          } finally {
            await device.close().catch(() => undefined);
          }
        });
      },
    },
    "standard:disconnect": {
      version: "1.0.0",
      async disconnect() {
        if (!connected) return;
        connected = null;
        // Keep the choice for the picker, but no silent reconnect after a reload.
        const saved = readSaved(storage);
        if (saved) writeSaved(storage, { ...saved, auto: false });
        emitChange();
      },
    },
    "standard:events": {
      version: "1.0.0",
      on<E extends StandardEventsNames>(event: E, listener: StandardEventsListeners[E]) {
        if (event !== "change") return () => undefined;
        listeners.add(listener as StandardEventsListeners["change"]);
        return () => { listeners.delete(listener as StandardEventsListeners["change"]); };
      },
    },
    "solana:signMessage": {
      version: "1.1.0",
      async signMessage(...inputs: readonly SolanaSignMessageInput[]): Promise<readonly SolanaSignMessageOutput[]> {
        const outputs: SolanaSignMessageOutput[] = [];
        for (const input of inputs) {
          const account = requireAccount(input);
          // Before any device access: an unsupported or over-long request never prompts.
          const { envelope, text } = ledgerMessageEnvelope(new Uint8Array(input.message), account.address);
          const signature = await withAccount("message", async (device) => {
            const app = await readAppInfo(device);
            if (!app.signsMessages) {
              throw new LedgerUsbError(
                "outdated_app",
                `The Ledger's Solana app ${app.version} cannot sign Manci requests. Update it to ${MIN_OFFCHAIN_APP_VERSION} or newer (Ledger Live → My Ledger), then try again.`,
              );
            }
            const hide = prompts.confirmOnDevice({ kind: "message", text });
            try {
              return await device.signOffchainMessage(account.path, envelope);
            } finally {
              hide();
            }
          });
          await assertSignature(signature, envelope, account.address);
          outputs.push({ signedMessage: envelope, signature, signatureType: "ed25519" });
        }
        return outputs;
      },
    },
    "solana:signTransaction": {
      version: "1.0.0",
      supportedTransactionVersions: ["legacy", 0],
      async signTransaction(...inputs: readonly SolanaSignTransactionInput[]): Promise<readonly SolanaSignTransactionOutput[]> {
        const outputs: SolanaSignTransactionOutput[] = [];
        for (const input of inputs) {
          const account = requireAccount(input);
          if (input.chain !== undefined && !SOLANA_CHAINS.includes(input.chain)) {
            throw new LedgerUsbError("unsupported_transaction", `The Ledger (USB) wallet does not sign for ${input.chain}.`);
          }
          let transaction: Transaction;
          try {
            transaction = getTransactionDecoder().decode(input.transaction);
          } catch (error) {
            throw new LedgerUsbError("unsupported_transaction", "This transaction could not be read. Nothing was signed.", { cause: error });
          }
          if (!(account.address in transaction.signatures)) {
            throw new LedgerUsbError("not_a_signer", "This transaction does not need the connected Ledger account's signature. Nothing was signed.");
          }
          const message = new Uint8Array(transaction.messageBytes);
          const hash = await ledgerMessageHash(message);
          const signature = await withAccount("transaction", async (device) => {
            const hide = prompts.confirmOnDevice({ kind: "transaction", hash });
            try {
              return await device.signTransaction(account.path, message);
            } finally {
              hide();
            }
          });
          await assertSignature(signature, message, account.address);
          const signed = getTransactionEncoder().encode({
            ...transaction,
            signatures: Object.freeze({ ...transaction.signatures, [account.address]: signature as SignatureBytes }),
          });
          outputs.push({ signedTransaction: new Uint8Array(signed) });
        }
        return outputs;
      },
    },
  };

  return Object.freeze({
    version: "1.0.0" as const,
    name: LEDGER_USB_WALLET_NAME,
    icon: ICON,
    chains: SOLANA_CHAINS,
    features,
    get accounts() {
      return connected ? [connected.account] : [];
    },
  });
}
