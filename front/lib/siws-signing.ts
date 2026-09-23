// Client strategy for signing a SIWS message with any wallet, including a
// Ledger. Byte layouts and limits: lib/siws-offchain.ts.
//
// How a Ledger user connects: open the Solana app on the Ledger, add the
// Ledger to Phantom ("Add / Connect Hardware Wallet") or Solflare ("Connect
// Ledger"), then connect Phantom/Solflare here as usual. Manci only sees the
// Wallet Standard `solana:signMessage` feature — there is no standard
// "sign off-chain message" feature (@solana/wallet-standard-features 1.3.0),
// and @solana/client hands back only the signature, not the `signedMessage`
// bytes the wallet actually signed. So the format is detected like this:
//
//   1. Ask the wallet to sign the raw SIWS text (one prompt). A software
//      wallet signs it as-is; a Ledger-aware wallet may wrap it in an
//      off-chain message first. We check the returned signature locally
//      against each byte string the server accepts and report that layout
//      as `sigFormat`. If WebCrypto Ed25519 is unavailable or nothing
//      matches, we report "raw" and the server remains the judge.
//   2. If the wallet/device REFUSES raw bytes (a hardware-wallet error, not
//      a user rejection), retry once with our own off-chain envelope — the
//      only thing a Ledger will sign. That wallet is remembered, so every
//      later action is again a single prompt.
//
// A request longer than a Ledger can sign fails with a clear
// OffchainMessageLimitError before any second prompt.

import type { WalletSession } from "@solana/client";
import { address, getPublicKeyFromAddress, signatureBytes, verifySignature } from "@solana/kit";
import {
  OffchainMessageLimitError,
  offchainEnvelopeBytes,
  SIWS_SIGNATURE_FORMATS,
  siwsSignedBytes,
  type SiwsSignatureFormat,
} from "@/lib/siws-offchain";

export type SiwsSignature = { signature: Uint8Array; sigFormat: SiwsSignatureFormat };

export class HardwareWalletSigningError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(
      "Your hardware wallet could not sign this request. Open the Solana app on your Ledger, update it and your wallet app (Phantom or Solflare) to the latest version, then try again.",
      options,
    );
    this.name = "HardwareWalletSigningError";
  }
}

// ── Per-wallet memory: "this wallet only signs off-chain envelopes" ─────────
const MODE_KEY = "manci:siws-signing:v1";
let envelopeWallets: Set<string> | null = null;

function loadEnvelopeWallets(): Set<string> {
  if (envelopeWallets) return envelopeWallets;
  envelopeWallets = new Set();
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(MODE_KEY) : null;
    const list: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(list)) for (const w of list) if (typeof w === "string") envelopeWallets.add(w);
  } catch { /* storage blocked or corrupt: start empty */ }
  return envelopeWallets;
}

function rememberEnvelopeWallet(wallet: string) {
  const set = loadEnvelopeWallets();
  set.add(wallet);
  try {
    window.localStorage.setItem(MODE_KEY, JSON.stringify([...set].slice(-20)));
  } catch { /* the in-memory copy still saves the extra prompt this session */ }
}

function forgetEnvelopeWallet(wallet: string) {
  const set = loadEnvelopeWallets();
  set.delete(wallet);
  try {
    window.localStorage.setItem(MODE_KEY, JSON.stringify([...set]));
  } catch { /* in-memory copy updated */ }
}

/** True once this wallet has needed our own off-chain envelope. */
export function signsOffchainEnvelopes(wallet: string): boolean {
  return loadEnvelopeWallets().has(wallet);
}

// ── Error classification ─────────────────────────────────────────────────────
function errorText(error: unknown, depth = 0): string {
  if (depth > 3) return "";
  if (error instanceof Error) return `${error.name} ${error.message} ${errorText(error.cause, depth + 1)}`;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return "";
}

/** The user said no — never follow a rejection with another prompt. */
function isUserRejection(error: unknown): boolean {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (code === 4001 || code === "WALLET_REJECTED") return true;
  // 0x6985 = the Ledger's "denied by the user".
  return /reject|declin|denied|cancel|0x6985|\b6985\b/i.test(errorText(error));
}

/** The wallet or device cannot sign arbitrary bytes (Ledger app status
 * 0x6a80–0x6a83 invalid message/header/format/size, 0x6808 blind signing). */
function isHardwareRefusal(error: unknown): boolean {
  return /ledger|hardware|off-?chain|not supported|unsupported|cannot sign|can't sign|unable to sign|invalid message|message (header|format|size)|blind.?sign|0x6a8[0-3]|\b6a8[0-3]\b|0x6808|\b6808\b/i
    .test(errorText(error));
}

// ── Local verification ───────────────────────────────────────────────────────
async function walletKey(wallet: string): Promise<CryptoKey | null> {
  try {
    return await getPublicKeyFromAddress(address(wallet));
  } catch {
    return null; // no WebCrypto Ed25519 here — the server decides
  }
}

/** true/false = checked; null = could not check locally. */
async function covers(key: CryptoKey | null, signature: Uint8Array, bytes: Uint8Array): Promise<boolean | null> {
  if (!key || signature.length !== 64) return null;
  try {
    return await verifySignature(key, signatureBytes(signature), bytes);
  } catch {
    return null;
  }
}

/** Which accepted byte string `signature` covers, or null when unknown. */
export async function detectSignedFormat(
  signature: Uint8Array,
  message: string,
  wallet: string,
): Promise<SiwsSignatureFormat | null> {
  const key = await walletKey(wallet);
  for (const format of SIWS_SIGNATURE_FORMATS) {
    let bytes: Uint8Array;
    try {
      bytes = siwsSignedBytes(message, wallet, format);
    } catch {
      continue; // over the off-chain limit: that layout is impossible
    }
    const verified = await covers(key, signature, bytes);
    if (verified === null) return null;
    if (verified) return format;
  }
  return null;
}

type SignMessage = NonNullable<WalletSession["signMessage"]>;

/**
 * Sign the canonical SIWS text with `session`, one prompt per action where
 * the wallet allows it. Returns the signature and the layout it covers.
 */
export async function signSiwsMessage(
  session: WalletSession,
  signMessage: SignMessage,
  message: string,
  wallet: string,
): Promise<SiwsSignature> {
  /** Sign our own envelope; false = the wallet signed something else. */
  const signEnvelope = async (): Promise<SiwsSignature & { verified: boolean | null }> => {
    // Throws OffchainMessageLimitError before prompting when too long.
    const envelope = offchainEnvelopeBytes(message, wallet, "offchain-v0");
    const signature = await signMessage.call(session, envelope);
    return { signature, sigFormat: "offchain-v0", verified: await covers(await walletKey(wallet), signature, envelope) };
  };

  if (signsOffchainEnvelopes(wallet)) {
    const { signature, sigFormat, verified } = await signEnvelope();
    // The wallet no longer signs our envelope as-is (e.g. it now wraps it
    // again): forget it so the next action starts from raw signing.
    if (verified === false) forgetEnvelopeWallet(wallet);
    return { signature, sigFormat };
  }

  let signature: Uint8Array;
  try {
    signature = await signMessage.call(session, new TextEncoder().encode(message));
  } catch (error) {
    if (isUserRejection(error) || !isHardwareRefusal(error)) throw error;
    let signed: Awaited<ReturnType<typeof signEnvelope>>;
    try {
      signed = await signEnvelope();
    } catch (retryError) {
      if (retryError instanceof OffchainMessageLimitError || isUserRejection(retryError)) throw retryError;
      throw new HardwareWalletSigningError({ cause: retryError });
    }
    if (signed.verified !== false) rememberEnvelopeWallet(wallet);
    return { signature: signed.signature, sigFormat: signed.sigFormat };
  }
  return { signature, sigFormat: (await detectSignedFormat(signature, message, wallet)) ?? "raw" };
}
