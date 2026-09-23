// Client strategy for signing a SIWS message with any wallet, including a
// Ledger. Byte layouts, limits and the format decision: lib/siws-offchain.ts.
//
// How a Ledger user connects: open the Solana app on the Ledger, add the
// Ledger to Phantom ("Add / Connect Hardware Wallet") or Solflare ("Connect
// Ledger"), then connect Phantom/Solflare here as usual. Manci only sees the
// Wallet Standard `solana:signMessage` feature — there is no standard
// "sign off-chain message" feature (@solana/wallet-standard-features 1.3.0),
// no standard way to tell that an account is hardware-backed, and
// @solana/client hands back only the signature, not the `signedMessage` bytes
// the wallet actually signed. So the format is worked out like this:
//
//   1. Ask the wallet to sign the raw SIWS text (one prompt). A software
//      wallet signs it as-is; a Ledger-aware wallet may wrap it in an
//      off-chain message first. The returned signature is checked locally
//      against every byte string the server accepts:
//        * a match → sent, labelled with that layout;
//        * cannot check (no WebCrypto Ed25519 here) → sent as "raw"; the
//          server tries every accepted layout itself;
//        * checked and matches nothing → NEVER sent (the server would only
//          answer 401). If the wallet wrapped non-ASCII text as UTF-8 — which
//          a Ledger shows only as a hash — ask once more with our own
//          restricted-ASCII envelope; otherwise HardwareWalletSigningError.
//   2. If the wallet/device refuses raw bytes for their FORMAT (Ledger status
//      0x6a80–0x6a83 or 0x6808, or a wallet saying a Ledger/hardware wallet
//      cannot sign such a message), retry once with our own envelope — the
//      only thing a Ledger will sign — and remember that wallet (connector +
//      address, 30 days) so later actions are a single prompt again.
//   3. Never a second prompt after: a user rejection (re-thrown as the
//      standard code 4001 error), a locked device or closed Solana app (a
//      clear "unlock" error), a request too long for a Ledger
//      (OffchainMessageLimitError, raised before prompting), or any other
//      wallet error (passed on unchanged; a "signing-failed" event lets the
//      page offer hardware-wallet signing by hand — components/
//      wallet-signing-notice.tsx — for wallets whose Ledger refusals arrive
//      as a generic error).
//   4. A remembered wallet signs our envelope directly. Any failure other
//      than a rejection, a locked device or an over-limit request forgets it,
//      so the next action starts again from step 1.

import type { WalletSession } from "@solana/client";
import { address, getPublicKeyFromAddress, signatureBytes, verifySignature } from "@solana/kit";
import {
  OFFCHAIN_SIGNATURE_FORMATS,
  offchainEnvelopeBytes,
  OffchainMessageLimitError,
  SIWS_SIGNATURE_FORMATS,
  siwsSignedBytes,
  utf8WrappedEnvelopeBytes,
  type SiwsSignatureFormat,
} from "@/lib/siws-offchain";

export type SiwsSignature = { signature: Uint8Array; sigFormat: SiwsSignatureFormat };

/** Why a hardware-wallet signature could not be produced or used. */
export type HardwareWalletFailure =
  | "unavailable" // device locked, Solana app closed or out of date
  | "refused" // refused raw bytes AND our off-chain envelope
  | "envelope_refused" // a remembered wallet stopped signing our envelope
  | "unrecognized" // signed bytes the server does not accept (checked locally)
  | "non_ascii"; // only signs non-ASCII text blindly (as a hash)

function failureCopy(reason: HardwareWalletFailure, ledger: boolean): string {
  switch (reason) {
    case "unavailable":
      return ledger
        ? "Your Ledger is locked, or its Solana app is not open or out of date. Unlock the Ledger, open the Solana app (update it in Ledger Live if asked), then try again."
        : "Your hardware wallet is locked or not ready. Unlock it, open its Solana app, then try again.";
    case "refused":
      return ledger
        ? "Your Ledger could not sign this request, even as a Solana off-chain message. Update the Solana app on the Ledger (in Ledger Live) and your wallet app (Phantom or Solflare), then try again."
        : "Your wallet could not sign this request, even as a Solana off-chain message. Update your wallet app (and your hardware wallet's Solana app, if you use one), then try again.";
    case "envelope_refused":
      return "Your wallet could not sign this request in hardware-wallet mode, so Manci switched this wallet back to standard signing. Try again.";
    case "unrecognized":
      return "Your wallet signed this request in a format Manci does not recognise, so nothing was sent. Try again; if it happens again, tell us your wallet app and version (and your Ledger's Solana app version, if you use a Ledger).";
    case "non_ascii":
      return "Your wallet would let your hardware wallet sign this request only blindly, as a hash, because it contains characters such as ć or đ. Manci accepts only requests your device can show in full, so nothing was sent. Use plain letters (c, d) in the text you entered, or use a software wallet for this action.";
  }
}

export class HardwareWalletSigningError extends Error {
  constructor(readonly reason: HardwareWalletFailure, options?: { cause?: unknown }) {
    super(failureCopy(reason, /ledger/i.test(errorText(options?.cause))), options);
    this.name = "HardwareWalletSigningError";
  }
}

// ── Per-wallet memory: "this wallet only signs off-chain envelopes" ─────────
// Keyed by wallet app (connector id) AND address, so a Ledger address moved to
// another wallet app starts from raw signing again. Entries expire.

/** Which wallet app + address a signing mode applies to. */
export type SigningTarget = { connectorId: string; wallet: string };

export function signingTarget(session: WalletSession, wallet = session.account.address.toString()): SigningTarget {
  const id: unknown = session.connector?.id;
  return { connectorId: typeof id === "string" && id.length > 0 ? id : "unknown", wallet };
}

const MODE_KEY = "manci:siws-signing:v1";
const MODE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MODE_MAX_ENTRIES = 20;
let envelopeModes: Map<string, number> | null = null; // key → expires at (ms)

const modeKey = (target: SigningTarget) => `${target.connectorId}|${target.wallet}`;

function loadModes(): Map<string, number> {
  if (envelopeModes) return envelopeModes;
  envelopeModes = new Map();
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(MODE_KEY) : null;
    const stored: unknown = raw ? JSON.parse(raw) : null;
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      for (const [key, expires] of Object.entries(stored)) {
        if (typeof expires === "number") envelopeModes.set(key, expires);
      }
    }
  } catch { /* storage blocked or corrupt: start empty */ }
  return envelopeModes;
}

function saveModes() {
  const now = Date.now();
  const live = [...loadModes()].filter(([, expires]) => expires > now)
    .sort((a, b) => a[1] - b[1]).slice(-MODE_MAX_ENTRIES);
  envelopeModes = new Map(live);
  try {
    window.localStorage.setItem(MODE_KEY, JSON.stringify(Object.fromEntries(live)));
  } catch { /* the in-memory copy still applies for this page */ }
}

/** True while this wallet app + address is in hardware-wallet (envelope) mode. */
export function signsOffchainEnvelopes(target: SigningTarget): boolean {
  const expires = loadModes().get(modeKey(target));
  return expires !== undefined && expires > Date.now();
}

/** Switch this wallet app + address to hardware-wallet signing (30 days,
 * renewed on each use). The manual fallback when auto-detection misses. */
export function preferOffchainEnvelope(target: SigningTarget) {
  loadModes().set(modeKey(target), Date.now() + MODE_TTL_MS);
  saveModes();
}

/** Back to standard signing (raw first) for this wallet app + address. */
export function resetSigningMode(target: SigningTarget) {
  loadModes().delete(modeKey(target));
  saveModes();
}

// ── Events for the page (components/wallet-signing-notice.tsx) ──────────────
export type SigningEvent =
  /** A second prompt is about to open, carrying our off-chain envelope. */
  | { type: "envelope-retry"; target: SigningTarget }
  /** The wallet failed in a way hardware-wallet signing might fix. */
  | { type: "signing-failed"; target: SigningTarget };

const listeners = new Set<(event: SigningEvent) => void>();

export function onSigningEvent(listener: (event: SigningEvent) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function emit(event: SigningEvent) {
  for (const listener of [...listeners]) {
    try { listener(event); } catch { /* a notice must never break signing */ }
  }
}

// ── Error classification ─────────────────────────────────────────────────────
function errorText(error: unknown, depth = 0): string {
  if (depth > 3 || error === null || error === undefined) return "";
  if (typeof error === "string") return error;
  if (typeof error !== "object") return "";
  const e = error as { name?: unknown; message?: unknown; statusCode?: unknown; cause?: unknown };
  const parts = [e.name, e.message].filter((part): part is string => typeof part === "string");
  // @ledgerhq TransportStatusError carries the APDU status as a number.
  if (typeof e.statusCode === "number") parts.push(`0x${e.statusCode.toString(16)}`);
  return `${parts.join(" ")} ${errorText(e.cause, depth + 1)}`;
}

/** The user said no — never follow a rejection with another prompt. */
function isUserRejection(error: unknown): boolean {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (code === 4001 || code === "WALLET_REJECTED") return true;
  // 0x6985 = the Ledger's "denied by the user".
  return /reject|declin|denied|cancel|0x6985|\b6985\b/i.test(errorText(error));
}

/** One standard shape for every rejection, so every screen shows "cancelled". */
function asUserRejection(error: unknown): unknown {
  if (error && typeof error === "object" && (error as { code?: unknown }).code === 4001) return error;
  return Object.assign(new Error("User rejected the request.", { cause: error }), { code: 4001 });
}

/** This app's own errors (e.g. the wallet changed mid-prompt) pass through. */
const APP_ERRORS = new Set(["TransactionWalletChangedError", "AccountSessionChangedError", "MaintenanceModeError"]);
function isAppError(error: unknown): boolean {
  return error instanceof OffchainMessageLimitError || (error instanceof Error && APP_ERRORS.has(error.name));
}

// Ledger errors name the device ("Ledger device: …"); a bare "transport" is
// not enough (WalletConnect/mobile wallets report "transport closed" too).
const HARDWARE = /ledger|hardware|trezor|keystone/i;

/** Locked device, Solana app closed/outdated, disconnected: a retry now would
 * fail the same way. Ledger 0x5515 locked, 0x6e0x/0x6511/0x650f app not open,
 * 0x6d0x instruction unknown (wrong or outdated app). */
function isDeviceUnavailable(error: unknown): boolean {
  const text = errorText(error);
  if (/0x5515\b|\b5515\b|0x6e0[0-9a-f]\b|0x6d0[0-9a-f]\b|0x6511\b|0x650f\b|lockeddevice|disconnecteddevice|transportracecondition/i.test(text)) return true;
  return HARDWARE.test(text) && /locked|not open|disconnect|not connected|no device|device not found|timed? ?out|busy/i.test(text);
}

/** The wallet/device refused the message FORMAT: Ledger 0x6a80–0x6a83
 * (invalid data/message/header/size), 0x6808 (needs blind signing — our
 * envelope is restricted ASCII, which does not), or a wallet saying that a
 * Ledger/hardware wallet cannot sign such a message. Deliberately narrow: a
 * software wallet's generic "not supported" is NOT a reason for a second,
 * binary-looking prompt. */
function isFormatRefusal(error: unknown): boolean {
  const text = errorText(error);
  if (/0x6a8[0-3]\b|\b6a8[0-3]\b|0x6808\b|\b6808\b|blind.?sign|invalid message|message (header|format|size)|off-?chain message/i.test(text)) return true;
  return HARDWARE.test(text) && /not supported|unsupported|cannot sign|can't sign|unable to sign|not able to sign/i.test(text);
}

// ── Local verification ───────────────────────────────────────────────────────
/** true/false = checked; null = could not check here (no WebCrypto Ed25519). */
type Verify = (signature: Uint8Array, bytes: Uint8Array) => Promise<boolean | null>;

function verifierFor(wallet: string): Verify {
  let key: Promise<CryptoKey | null> | null = null;
  return async (signature, bytes) => {
    if (signature.length !== 64) return false; // not an ed25519 signature at all
    key ??= (async () => {
      try {
        return await getPublicKeyFromAddress(address(wallet));
      } catch {
        return null;
      }
    })();
    const publicKey = await key;
    if (!publicKey) return null;
    try {
      return await verifySignature(publicKey, signatureBytes(signature), bytes);
    } catch {
      return null;
    }
  };
}

/** Which accepted byte string `signature` covers: a format, "none" (checked,
 * the server would reject it) or "unknown" (could not check here). */
export async function detectSignedFormat(
  signature: Uint8Array,
  message: string,
  wallet: string,
  verify: Verify = verifierFor(wallet),
): Promise<SiwsSignatureFormat | "none" | "unknown"> {
  for (const format of SIWS_SIGNATURE_FORMATS) {
    let bytes: Uint8Array;
    try {
      bytes = siwsSignedBytes(message, wallet, format);
    } catch {
      continue; // over the off-chain limit: that layout is impossible
    }
    const verified = await verify(signature, bytes);
    if (verified === null) return "unknown";
    if (verified) return format;
  }
  return "none";
}

/** Did the wallet wrap the raw non-ASCII text as a UTF-8 off-chain message? */
async function wrappedAsUtf8(signature: Uint8Array, message: string, wallet: string, verify: Verify) {
  for (const layout of OFFCHAIN_SIGNATURE_FORMATS) {
    const bytes = utf8WrappedEnvelopeBytes(message, wallet, layout);
    if (bytes && (await verify(signature, bytes)) === true) return true;
  }
  return false;
}

type SignMessage = NonNullable<WalletSession["signMessage"]>;

/**
 * Sign the canonical SIWS text with `session`, one prompt per action where
 * the wallet allows it. Returns the signature and the layout it covers, or
 * throws — it never returns a signature it has shown the server will reject.
 */
export async function signSiwsMessage(
  session: WalletSession,
  signMessage: SignMessage,
  message: string,
  wallet: string,
): Promise<SiwsSignature> {
  const target = signingTarget(session, wallet);
  const verify = verifierFor(wallet);

  /** Sign our own restricted-ASCII envelope. Throws OffchainMessageLimitError
   * before any prompt when the request is too long for a Ledger. */
  const signEnvelope = async (beforePrompt?: () => void) => {
    const envelope = offchainEnvelopeBytes(message, wallet, "offchain-v0");
    beforePrompt?.();
    const signature = await signMessage.call(session, envelope);
    return { signature, verified: await verify(signature, envelope) };
  };

  if (signsOffchainEnvelopes(target)) {
    let signed: Awaited<ReturnType<typeof signEnvelope>>;
    try {
      signed = await signEnvelope();
    } catch (error) {
      if (isAppError(error)) throw error;
      if (isUserRejection(error)) throw asUserRejection(error);
      if (isDeviceUnavailable(error)) throw new HardwareWalletSigningError("unavailable", { cause: error });
      // Anything else (a wallet update, the address now used from another
      // wallet app): forget, so the next action starts from raw signing.
      resetSigningMode(target);
      throw new HardwareWalletSigningError("envelope_refused", { cause: error });
    }
    if (signed.verified === false) {
      // The wallet no longer signs our envelope as-is (e.g. it now wraps it again).
      resetSigningMode(target);
      throw new HardwareWalletSigningError("unrecognized");
    }
    preferOffchainEnvelope(target); // renew the memory
    return { signature: signed.signature, sigFormat: "offchain-v0" };
  }

  /** The one retry: our envelope, after the wallet refused or mis-wrapped. */
  const retryWithEnvelope = async (onFailure: "refused" | "non_ascii"): Promise<SiwsSignature> => {
    let signed: Awaited<ReturnType<typeof signEnvelope>>;
    try {
      signed = await signEnvelope(() => emit({ type: "envelope-retry", target }));
    } catch (error) {
      if (isAppError(error)) throw error;
      if (isUserRejection(error)) throw asUserRejection(error);
      if (isDeviceUnavailable(error)) throw new HardwareWalletSigningError("unavailable", { cause: error });
      throw new HardwareWalletSigningError(onFailure, { cause: error });
    }
    if (signed.verified === false) {
      throw new HardwareWalletSigningError(onFailure === "non_ascii" ? "non_ascii" : "unrecognized");
    }
    preferOffchainEnvelope(target);
    return { signature: signed.signature, sigFormat: "offchain-v0" };
  };

  let signature: Uint8Array;
  try {
    signature = await signMessage.call(session, new TextEncoder().encode(message));
  } catch (error) {
    if (isAppError(error)) throw error;
    if (isUserRejection(error)) throw asUserRejection(error);
    if (isDeviceUnavailable(error)) throw new HardwareWalletSigningError("unavailable", { cause: error });
    if (isFormatRefusal(error)) return retryWithEnvelope("refused");
    emit({ type: "signing-failed", target });
    throw error;
  }
  const detected = await detectSignedFormat(signature, message, wallet, verify);
  if (detected === "unknown") return { signature, sigFormat: "raw" }; // the server tries every layout
  if (detected !== "none") return { signature, sigFormat: detected };
  // Checked here: the server would reject this signature, so it is not sent.
  if (await wrappedAsUtf8(signature, message, wallet, verify)) return retryWithEnvelope("non_ascii");
  emit({ type: "signing-failed", target });
  throw new HardwareWalletSigningError("unrecognized");
}
