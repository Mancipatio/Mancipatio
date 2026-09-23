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
// Contract (shared by lib/siws-signing.ts and lib/server/siws.ts):
//   * The envelope BODY is offchainBodyText(siwsMessage(payload)): the same
//     canonical SIWS text, with every character outside printable ASCII
//     written as a JSON \uXXXX escape (see "Body text" below). For an
//     all-ASCII request — almost every request — it is byte-for-byte the
//     canonical text. Payload, nonce, origin, network, expiry and session
//     rules do not change.
//   * The server rebuilds every accepted byte string itself from the payload
//     and the signed wallet with the builders below; client-supplied envelope
//     bytes are never accepted. `sigFormat` from the client is only a hint.
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
//                          version produces is not observable from the dApp.
//                          It adds no signing capability an attacker lacks:
//                          any tool that signs arbitrary bytes can already
//                          produce a valid "raw" signature over the same text.
//       domain | version 0x00 | format (1) | body length (u16) | body
//
// Application domain — DECISION: 32 zero bytes (base58 "1111…1"). The domain
// is unauthenticated bytes that any dApp may set, so a fixed "Manci" domain
// would add no protection: domain separation already lives in the signed body
// (the "mancipatio:v2:" prefix, exact origin, network, action and a one-time
// nonce). Zero is what a wallet that wraps a plain signMessage request has no
// reason to change, so it keeps one strict candidate per layout.
//
// Format byte — DECISION: always 0 (restricted ASCII, 0x20–0x7e). This is the
// only format a Ledger shows in full on its screen. A UTF-8 body (format 1)
// is shown only as a hash and needs the device-wide blind-signing setting, so
// the user could no longer see the origin, action or params they approve — the
// check a hardware wallet exists for. The server therefore never accepts a
// format-1 envelope, and nothing in the app asks users to enable blind signing.
//
// Body text — to keep format 0 for text such as "Rakić", every UTF-16 code
// unit outside 0x20–0x7e is written as \uXXXX (lowercase hex). In the
// canonical text such characters only ever occur inside JSON string literals
// (canonicalJson uses JSON.stringify, which already escapes control
// characters), where \uXXXX is the standard JSON escape for the same code
// unit: JSON.parse returns the identical payload, so the body is a
// deterministic, one-to-one encoding of it. The device shows e.g. Rakić.
//
// Limit: the body must be 1..1212 bytes — solana-sdk MAX_LEN_LEDGER
// (1232-byte packet − 17-byte base header − 3-byte v0 header), the stricter of
// the two layouts. Each escaped character costs 6 bytes. A longer request
// cannot be signed on a Ledger and fails with OffchainMessageLimitError; the
// raw path has no such limit.

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
export const OFFCHAIN_SIGNATURE_FORMATS: readonly OffchainSignatureFormat[] = ["offchain-v0", "offchain-v0-legacy"];

export function isSiwsSignatureFormat(value: unknown): value is SiwsSignatureFormat {
  return typeof value === "string" && (SIWS_SIGNATURE_FORMATS as readonly string[]).includes(value);
}

/** "\xffsolana offchain" — the off-chain message signing domain. */
export const OFFCHAIN_SIGNING_DOMAIN = Uint8Array.from([
  0xff, ...Array.from("solana offchain", (c) => c.charCodeAt(0)),
]);

/** 32 zero bytes, base58 — see the application-domain decision above. */
export const OFFCHAIN_APPLICATION_DOMAIN = "11111111111111111111111111111111";

/** Largest body (escaped SIWS text, bytes) a Ledger can sign. */
export const OFFCHAIN_MAX_BODY_BYTES = 1212;

/** How many bytes one escaped (non-ASCII) character takes in the body. */
export const OFFCHAIN_ESCAPED_CHAR_BYTES = 6;

export class OffchainMessageLimitError extends Error {
  /** Roughly how many characters must go (bytes of the body over the limit). */
  readonly excess: number;
  constructor(readonly bytes: number) {
    const excess = Math.max(0, bytes - OFFCHAIN_MAX_BODY_BYTES);
    super(
      bytes === 0
        ? "An empty request cannot be signed with a hardware wallet."
        : `This request is about ${excess} character${excess === 1 ? "" : "s"} too long to sign with a hardware wallet. ` +
          `Shorten the text you entered (letters such as ć or đ count as ${OFFCHAIN_ESCAPED_CHAR_BYTES} characters each), or use a software wallet for this action.`,
    );
    this.name = "OffchainMessageLimitError";
    this.excess = excess;
  }
}

const utf8 = new TextEncoder();
const NOT_RESTRICTED_ASCII = /[^\x20-\x7e]/g;

/** True when every character is printable ASCII (0x20–0x7e). */
export function isRestrictedAscii(text: string): boolean {
  return /^[\x20-\x7e]+$/.test(text);
}

/** The off-chain body for a canonical SIWS text: non-ASCII → \uXXXX. */
export function offchainBodyText(message: string): string {
  return message.replace(NOT_RESTRICTED_ASCII, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** Bytes the off-chain body of `message` takes (what the limit counts). */
export function offchainBodyLength(message: string): number {
  return offchainBodyText(message).length; // pure ASCII: 1 char = 1 byte
}

function encodeEnvelope(text: string, wallet: string, layout: OffchainSignatureFormat, format: 0 | 1): Uint8Array {
  if (layout === "offchain-v0-legacy") {
    const body = utf8.encode(text);
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

/**
 * Build the exact off-chain message bytes the server accepts for the
 * canonical SIWS `message` signed by `wallet`: restricted-ASCII body
 * (format 0). Throws OffchainMessageLimitError (length) or a Kit error
 * (invalid wallet).
 */
export function offchainEnvelopeBytes(
  message: string,
  wallet: string,
  layout: OffchainSignatureFormat,
): Uint8Array {
  const body = offchainBodyText(message);
  if (body.length === 0 || body.length > OFFCHAIN_MAX_BODY_BYTES) {
    throw new OffchainMessageLimitError(body.length);
  }
  return encodeEnvelope(body, wallet, layout, 0);
}

/**
 * NEVER accepted by the server. The UTF-8 (format 1) envelope a wallet would
 * build if it wrapped the raw, non-ASCII `message` itself — a Ledger can show
 * that only as a hash. The client uses it solely to recognise that case and
 * ask again with the restricted-ASCII envelope. Null when not applicable.
 */
export function utf8WrappedEnvelopeBytes(
  message: string,
  wallet: string,
  layout: OffchainSignatureFormat,
): Uint8Array | null {
  if (isRestrictedAscii(message) || utf8.encode(message).length > OFFCHAIN_MAX_BODY_BYTES) return null;
  try {
    return encodeEnvelope(message, wallet, layout, 1);
  } catch {
    return null; // over Kit's 1232-byte cap or invalid wallet: no such envelope
  }
}

/** The byte string a signature in `format` must cover. */
export function siwsSignedBytes(
  message: string,
  wallet: string,
  format: SiwsSignatureFormat,
): Uint8Array {
  return format === "raw" ? utf8.encode(message) : offchainEnvelopeBytes(message, wallet, format);
}
