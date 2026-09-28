// rc.x account types that left the IDL in v1.0.0-rc (8.3), for the plain-Node
// ops scripts (devnet-rollout-inventory.mjs cannot import TypeScript). The
// TypeScript twin is lib/legacy-accounts.ts; tests/legacy-accounts.test.ts
// keeps the two identical. Matched by the Anchor discriminator
// sha256("account:<Name>")[0..8] AND the exact rc.x size.
import { createHash } from 'node:crypto';

const discriminator = (name) => createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);

export const LEGACY_ACCOUNTS = Object.freeze([
  Object.freeze({ name: 'AuthorityTransfer', program: 'asset_registry', seed: 'authority_transfer', size: 137, discriminator: discriminator('AuthorityTransfer') }),
  Object.freeze({ name: 'BlocklistAuthorityTransfer', program: 'transfer_hook', seed: 'blocklist_authority_transfer', size: 73, discriminator: discriminator('BlocklistAuthorityTransfer') }),
]);

/** The legacy type of an account of `programName` ('asset_registry' | 'transfer_hook'), or null. */
export function legacyAccountType(programName, data) {
  for (const legacy of LEGACY_ACCOUNTS) {
    if (legacy.program !== programName || data.length !== legacy.size) continue;
    if (Buffer.from(data.subarray(0, 8)).equals(legacy.discriminator)) return legacy;
  }
  return null;
}
