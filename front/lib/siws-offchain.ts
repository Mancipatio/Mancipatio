// SIWS over Solana OFF-CHAIN MESSAGES — the byte strings a hardware wallet signs.
//
// Why this exists: Ledger's Solana app never signs arbitrary bytes. It signs
// only a Solana off-chain message — a fixed preamble that starts with
// "\xffsolana offchain", followed by the text it shows on the device. A wallet
// that fronts a Ledger (Phantom or Solflare with "Connect Ledger") therefore
// either wraps our SIWS text in that envelope itself or refuses raw bytes. In
// both cases the ed25519 signature covers the ENVELOPE, so the raw-bytes check
// in lib/server/siws.ts would reject an honest Ledger user.
//
// Contract (shared by lib/siws-client.ts and lib/server/siws.ts):
//   * The envelope BODY is exactly siwsMessage(payload) — the same canonical
//     text as the raw path, UTF-8 encoded. Nothing about the payload,
//     nonce, origin, network, expiry or session rules changes.
//   * The client only NAMES the layout it used (`sigFormat`). The server
//     rebuilds the envelope bytes itself from the canonical text and the
//     signed wallet with the builders below; client-supplied envelope bytes
//     are never accepted. Each format verifies exactly one byte string.
//   * Every envelope begins with 0xff, so it can never equal a raw SIWS
//     message (which begins with "mancipatio:v2:") or a Solana transaction
//     message — a signature cannot be re-used across the three.
//
// Layouts ("\xffsolana offchain" is the 16-byte signing domain, u16 is LE):
//   "offchain-v0"        — the current off-chain message spec (SRFC 3), as
//                          implemented by @solana/kit getOffchainMessageV0Encoder
//                          (and, per its spec, recent Ledger Solana app
//                          releases — not yet verified on a device):
//       domain | version 0x00 | application domain (32) | format (1)
//       | signer count (1) = 1 | signer = the signing wallet (32)
//       | body length (u16) | body
//   "offchain-v0-legacy" — the original solana-sdk `offchain_message::v0`
//                          (`solana sign-offchain-message`; older Ledger app
//                          releases), which has no application domain/signers.
//                          Accepted because which layout a given wallet + app
//                          version produces is not observable from the dApp:
//       domain | version 0x00 | format (1) | body length (u16) | body
//
// Application domain — DECISION: 32 zero bytes (base58 "1111…1"). The domain
// is unauthenticated bytes that any dApp may set, so a fixed "Manci" domain
// would add no protection: domain separation already lives in the signed body
// (the "mancipatio:v2:" prefix, exact origin, network, action and a one-time
// nonce). Zero is what a wallet that wraps a plain signMessage request has no
// reason to change, so it keeps one strict candidate per layout.
//
// Format byte — the solana-sdk rule, applied deterministically by both sides:
// 0 (restricted ASCII) when every character is printable ASCII 0x20–0x7e,
// otherwise 1 (UTF-8). Restricted ASCII exists so a Ledger can show the whole
// text on screen; a UTF-8 body (e.g. a display name with "ć") may need the
// device's blind-signing setting. Limit: the body must be 1..1212 bytes — solana-sdk MAX_LEN_LEDGER
// (1232-byte packet − 17-byte base header − 3-byte v0 header), the stricter of
// the two layouts. A longer request cannot be signed on a Ledger and fails
// with OffchainMessageLimitError; the raw path has no such limit.

import {
  address,
  getOffchainMessageV0Encoder,
  offchainMessageContentRestrictedAsciiOf1232BytesMax,
  offchainMessageContentUtf8Of1232BytesMax,
  type OffchainMessageApplicationDomain,
  type OffchainMessageV0,
} from "@solana/kit";

/** Which bytes a SIWS signature covers. Absent on the wire = "raw". */
export const SIWS_SIGNATURE_FORMATS = ["raw", "offchain-v0", "offchain-v0-legacy"] as const;
export type SiwsSignatureFormat = (typeof SIWS_SIGNATURE_FORMATS)[number];
export type OffchainSignatureFormat = Exclude<SiwsSignatureFormat, "raw">;

export function isSiwsSignatureFormat(value: unknown): value is SiwsSignatureFormat {
  return typeof value === "string" && (SIWS_SIGNATURE_FORMATS as readonly string[]).includes(value);
}

/** "\xffsolana offchain" — the off-chain message signing domain. */
export const OFFCHAIN_SIGNING_DOMAIN = Uint8Array.from([
  0xff, ...Array.from("solana offchain", (c) => c.charCodeAt(0)),
]);

/** 32 zero bytes, base58 — see the application-domain decision above. */
export const OFFCHAIN_APPLICATION_DOMAIN = "11111111111111111111111111111111";

/** Largest body (canonical SIWS text, UTF-8 bytes) a Ledger can sign. */
export const OFFCHAIN_MAX_BODY_BYTES = 1212;

export class OffchainMessageLimitError extends Error {
  constructor(readonly bytes: number) {
    super(
      bytes === 0
        ? "An empty request cannot be signed with a hardware wallet."
        : `This request is too long to sign with a hardware wallet (${bytes} bytes; the limit is ${OFFCHAIN_MAX_BODY_BYTES}). Shorten the text fields or use a software wallet for this action.`,
    );
    this.name = "OffchainMessageLimitError";
  }
}

const utf8 = new TextEncoder();

/** 0 = restricted ASCII (every char 0x20–0x7e), 1 = UTF-8. */
export function offchainMessageFormat(text: string): 0 | 1 {
  return /^[\x20-\x7e]+$/.test(text) ? 0 : 1;
}

function checkedBody(text: string): Uint8Array {
  const body = utf8.encode(text);
  if (body.length === 0 || body.length > OFFCHAIN_MAX_BODY_BYTES) {
    throw new OffchainMessageLimitError(body.length);
  }
  return body;
}

/**
 * Build the exact off-chain message bytes for `text` signed by `wallet`.
 * Throws OffchainMessageLimitError (length) or a Kit error (invalid wallet).
 */
export function offchainEnvelopeBytes(
  text: string,
  wallet: string,
  layout: OffchainSignatureFormat,
): Uint8Array {
  const body = checkedBody(text);
  const format = offchainMessageFormat(text);
  if (layout === "offchain-v0-legacy") {
    const out = new Uint8Array(OFFCHAIN_SIGNING_DOMAIN.length + 4 + body.length);
    out.set(OFFCHAIN_SIGNING_DOMAIN, 0);
    let at = OFFCHAIN_SIGNING_DOMAIN.length;
    out[at++] = 0; // header version
    out[at++] = format;
    out[at++] = body.length & 0xff; // u16 little-endian
    out[at++] = body.length >> 8;
    out.set(body, at);
    return out;
  }
  const preamble = {
    version: 0 as const,
    applicationDomain: OFFCHAIN_APPLICATION_DOMAIN as OffchainMessageApplicationDomain,
    requiredSignatories: [{ address: address(wallet) }],
  };
  // Kit re-validates the character set and the 1232-byte format cap.
  const message: OffchainMessageV0 = format === 0
    ? { ...preamble, content: offchainMessageContentRestrictedAsciiOf1232BytesMax(text) }
    : { ...preamble, content: offchainMessageContentUtf8Of1232BytesMax(text) };
  return Uint8Array.from(getOffchainMessageV0Encoder().encode(message));
}

/** The one byte string a signature in `format` must cover. */
export function siwsSignedBytes(
  message: string,
  wallet: string,
  format: SiwsSignatureFormat,
): Uint8Array {
  return format === "raw" ? utf8.encode(message) : offchainEnvelopeBytes(message, wallet, format);
}
