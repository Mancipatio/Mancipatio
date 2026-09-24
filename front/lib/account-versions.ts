/** Strict current-layout decoders. The program has no v1 ShareClass or
 * PayoutVault path, so any other version fails closed instead of being shown
 * or acted on. */
import type { Decoder, ReadonlyUint8Array } from "@solana/kit";
import {
  getPayoutVaultDecoder,
  getPayoutVaultDiscriminatorBytes,
  getShareClassDecoder,
  getShareClassDiscriminatorBytes,
  type PayoutVault,
  type ShareClass,
} from "@/lib/generated/asset_registry";

const CURRENT_VERSION = 2;
/** v2 appended exactly 9 bytes to both layouts (`lifetimeMinted` + `cumulativeCap`,
 * `voteRound` + `votePending`), so an original v1 account is that much shorter. */
const V2_TAIL_BYTES = 9;

function decodeCurrent<T extends { version: number }>(
  label: string,
  bytes: Uint8Array,
  discriminator: ReadonlyUint8Array,
  decoder: Decoder<T>,
): T {
  if (bytes.length < 8 || !discriminator.every((b, i) => b === bytes[i])) {
    throw new Error(`Unexpected ${label} discriminator`);
  }
  let decoded: T;
  try {
    decoded = decoder.decode(bytes);
  } catch (err) {
    // A physically shorter original v1 account cannot decode as v2. Read its
    // version only to name the failure; a truncated v2 keeps the decode error.
    let version: number | null = null;
    try {
      const padded = new Uint8Array(bytes.length + V2_TAIL_BYTES);
      padded.set(bytes);
      version = decoder.decode(padded).version;
    } catch {
      /* unreadable prefix: report the original decode error */
    }
    if (version !== null && version !== CURRENT_VERSION) throw unsupported(label, version);
    throw err;
  }
  if (decoded.version !== CURRENT_VERSION) throw unsupported(label, decoded.version);
  return decoded;
}

function unsupported(label: string, version: number) {
  return new Error(`Unsupported ${label} version ${version}; the current program has no v1 path`);
}

export function decodeShareClassV2(bytes: Uint8Array): ShareClass {
  return decodeCurrent("ShareClass", bytes, getShareClassDiscriminatorBytes(), getShareClassDecoder());
}

export function decodePayoutVaultV2(bytes: Uint8Array): PayoutVault {
  return decodeCurrent("PayoutVault", bytes, getPayoutVaultDiscriminatorBytes(), getPayoutVaultDecoder());
}
