// rc.x account types that left the IDL in v1.0.0-rc (8.3). Their layouts are
// no longer generated, so they are recognised by the pinned Anchor
// discriminator (sha256("account:<Name>")[0..8]) AND the exact rc.x size:
//
// * asset_registry `AuthorityTransfer` (137 B) at ["authority_transfer",
//   target] — replaced by `AuthorityProposal` at ["authority_proposal", target];
// * transfer_hook `BlocklistAuthorityTransfer` (73 B) at
//   ["blocklist_authority_transfer"] — replaced by `BlocklistAuthorityProposal`.
//
// The v1 program neither reads nor closes them (a pending rc.x rotation is
// inert under v1, and invisible to it). The chain inventory blocks the
// upgrade while any exists (devnet plan B1); the indexer and the devnet
// rollout inventory name them instead of treating them as unknown layouts.
// tests/legacy-accounts.test.ts pins the discriminators to the names and the
// sizes to the program's own `8 + INIT_SPACE` asserts.
import { ASSET_REGISTRY_PROGRAM_ADDRESS } from "@/lib/generated/asset_registry";
import { TRANSFER_HOOK_PROGRAM_ADDRESS } from "@/lib/generated/transfer_hook";

export type LegacyAccountType = {
  name: "AuthorityTransfer" | "BlocklistAuthorityTransfer";
  program: "asset_registry" | "transfer_hook";
  programAddress: string;
  /** The rc.x seed prefix (for the operator's message). */
  seed: string;
  discriminator: Uint8Array;
  size: number;
};

export const LEGACY_AUTHORITY_TRANSFER: LegacyAccountType = {
  name: "AuthorityTransfer",
  program: "asset_registry",
  programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
  seed: "authority_transfer",
  discriminator: Uint8Array.from([43, 243, 199, 71, 139, 255, 231, 113]),
  size: 137,
};

export const LEGACY_BLOCKLIST_AUTHORITY_TRANSFER: LegacyAccountType = {
  name: "BlocklistAuthorityTransfer",
  program: "transfer_hook",
  programAddress: TRANSFER_HOOK_PROGRAM_ADDRESS,
  seed: "blocklist_authority_transfer",
  discriminator: Uint8Array.from([171, 162, 208, 78, 168, 214, 135, 50]),
  size: 73,
};

export const LEGACY_ACCOUNT_TYPES: readonly LegacyAccountType[] = [
  LEGACY_AUTHORITY_TRANSFER,
  LEGACY_BLOCKLIST_AUTHORITY_TRANSFER,
];

/**
 * The legacy rc.x type of an account owned by `owner`, or null. The owner,
 * the discriminator and the exact size must all match: a same-discriminator
 * account of any other size is not this layout.
 */
export function legacyAccountType(owner: string, data: Uint8Array): LegacyAccountType | null {
  for (const legacy of LEGACY_ACCOUNT_TYPES) {
    if (owner !== legacy.programAddress || data.length !== legacy.size) continue;
    if (legacy.discriminator.every((b, i) => data[i] === b)) return legacy;
  }
  return null;
}
