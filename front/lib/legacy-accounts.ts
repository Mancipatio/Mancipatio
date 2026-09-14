/** Explicit read-only v1 layouts. New ledger and round fields remain unknown;
 * only separately verified legacy exit flows may construct legacy mutations. */
import type { ReadonlyUint8Array } from "@solana/kit";
import { getShareClassDecoder, getShareClassDiscriminatorBytes, getPayoutVaultDecoder, getPayoutVaultDiscriminatorBytes, getVaultVoteDecoder, getVaultVoteDiscriminatorBytes,
  type ShareClass, type PayoutVault, type VaultVote } from "@/lib/generated/asset_registry";
import { getLegacyShareClassPrefixDecoder, getLegacyPayoutVaultPrefixDecoder, getLegacyVaultVotePrefixDecoder } from "@/lib/legacy-account-decoders";
export type LegacyShareClass = Omit<ShareClass, "lifetimeMinted" | "cumulativeCap"> & { version: 1; readonlyLegacy: true; lifetimeMinted: null; cumulativeCap: null };
export type LegacyPayoutVault = Omit<PayoutVault, "voteRound" | "votePending"> & { version: 1; readonlyLegacy: true; voteRound: null; votePending: null };
export type LegacyVaultVote = Omit<VaultVote, "round"> & { version: 1; readonlyLegacy: true; round: null };
function check(bytes: Uint8Array, discriminator: ReadonlyUint8Array, version: number) {
  if (!discriminator.every((b, i) => b === bytes[i])) throw new Error("Unexpected account discriminator");
  if (version !== 1 && version !== 2) throw new Error(`Unsupported account version ${version}`);
}
export function decodeReadableShareClass(bytes: Uint8Array): ShareClass | LegacyShareClass {
  const prefix = getLegacyShareClassPrefixDecoder().decode(bytes); check(bytes, getShareClassDiscriminatorBytes(), prefix.version);
  return prefix.version === 1 ? { ...prefix, version: 1, readonlyLegacy: true, lifetimeMinted: null, cumulativeCap: null } : getShareClassDecoder().decode(bytes);
}
export function decodeReadablePayoutVault(bytes: Uint8Array): PayoutVault | LegacyPayoutVault {
  const prefix = getLegacyPayoutVaultPrefixDecoder().decode(bytes); check(bytes, getPayoutVaultDiscriminatorBytes(), prefix.version);
  return prefix.version === 1 ? { ...prefix, version: 1, readonlyLegacy: true, voteRound: null, votePending: null } : getPayoutVaultDecoder().decode(bytes);
}
export function decodeReadableVaultVote(bytes: Uint8Array): VaultVote | LegacyVaultVote {
  const prefix = getLegacyVaultVotePrefixDecoder().decode(bytes); check(bytes, getVaultVoteDiscriminatorBytes(), prefix.version);
  return prefix.version === 1 ? { ...prefix, version: 1, readonlyLegacy: true, round: null } : getVaultVoteDecoder().decode(bytes);
}
export function isLegacyShareClass(a: ShareClass | LegacyShareClass): a is LegacyShareClass { return "readonlyLegacy" in a; }
export function isLegacyPayoutVault(a: PayoutVault | LegacyPayoutVault): a is LegacyPayoutVault { return "readonlyLegacy" in a; }
export function isLegacyVaultVote(a: VaultVote | LegacyVaultVote): a is LegacyVaultVote { return "readonlyLegacy" in a; }
