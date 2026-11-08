// The admin wallet's Ed25519 signature over a certificate's message
// (lib/certificates/payload.ts certificateMessage):
//
//   Manci certificate v1
//   Number: MC-2026-0001
//   SHA-256: <64 lowercase hex>
//
// The browser signs it with the same helper as a SIWS request
// (lib/siws-signing.ts signSiwsMessage): one signMessage prompt over the raw
// text, or, for a wallet in front of a Ledger, the restricted-ASCII Solana
// off-chain message around it (lib/siws-offchain.ts). The verification
// accepts exactly the byte strings SIWS accepts for that text and that
// wallet ("raw", "offchain-v0", "offchain-v0-legacy"), and reports which one
// the signature covers, so the stored certificate says what was signed.
//
// Domain separation: the message starts with "Manci certificate v1", a SIWS
// message with "mancipatio:v2:", an off-chain envelope with 0xff and a
// transaction message with neither, so a certificate signature can never be
// replayed as a sign-in, a signed request or a transaction, nor the reverse.
// The message names the number and the hash, and the hash covers the network
// and a random salt, so one signature fits one certificate only.
//
// Pure (WebCrypto Ed25519 through @solana/kit): the sign route verifies
// before it stores, the public route re-verifies before it answers.

import {
  address,
  getBase58Decoder,
  getBase58Encoder,
  getPublicKeyFromAddress,
  isAddress,
  signatureBytes,
  verifySignature,
} from "@solana/kit";
import { SIWS_SIGNATURE_FORMATS, siwsSignedBytes, type SiwsSignatureFormat } from "@/lib/siws-offchain";

/** A signature as base58 (the form a certificate prints and stores). */
export function signatureToBase58(signature: Uint8Array): string {
  if (signature.length !== 64) throw new Error("An Ed25519 signature is 64 bytes");
  return getBase58Decoder().decode(signature);
}

/** The 64 signature bytes of a base58 string, or null when it is not one. */
export function signatureFromBase58(text: string): Uint8Array | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(text)) return null;
  try {
    const bytes = Uint8Array.from(getBase58Encoder().encode(text));
    return bytes.length === 64 ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Which byte string of `message` the base58 `signature` by `signer` covers,
 * trying `preferred` first; null when it verifies against none of them (a
 * wrong signer, another message, a malformed signature). Throws when this
 * runtime cannot import the key (no Ed25519 WebCrypto): the caller cannot
 * tell then, and must not answer either way.
 */
export async function certificateSignatureFormat(
  message: string,
  signer: string,
  signature: string,
  preferred: SiwsSignatureFormat = "raw",
): Promise<SiwsSignatureFormat | null> {
  const bytes = signatureFromBase58(signature);
  if (!bytes || !isAddress(signer)) return null;
  const key = await getPublicKeyFromAddress(address(signer));
  for (const format of [preferred, ...SIWS_SIGNATURE_FORMATS.filter((f) => f !== preferred)]) {
    let signed: Uint8Array;
    try {
      signed = siwsSignedBytes(message, signer, format);
    } catch {
      continue; // over the off-chain limit: that layout cannot exist
    }
    if (await verifySignature(key, signatureBytes(bytes), signed)) return format;
  }
  return null;
}
