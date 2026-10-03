// The highest raise limit an admin can set: the platform default and the
// per-client overrides (POST /api/admin-config/raise-limits and
// /api/clients/raise-limits). Both feed the issuer cap of sale approvals
// (0066 sale_capacity: the most permissive override wins) and the /apply
// check (0056).
//
// On Solana mainnet the ceiling is the Terms' limit: at most EUR 3,000,000
// per issuer over any twelve months, or per SPV where the issuer issues
// through one (lib/legal/mainnet-copy.ts clause 7, the owner's decision D4).
// A higher limit would make the Terms untrue, so the routes refuse it. SPV
// caps (spvs.annual_cap_eur) keep the EUR 3,000,000 default of 0018, and no
// route changes them. Other networks keep the old bound, so devnet can
// rehearse any value.
//
// Import-free apart from a type: client pages and server routes share it.

import type { Network } from "@/lib/network";

/** The Terms' limit (clause 7) and the ceiling of every raise limit on mainnet. */
export const MAINNET_RAISE_CAP_EUR = 3_000_000;

/** The ceiling on devnet, testnet and localnet. */
export const TEST_NETWORK_RAISE_CAP_MAX_EUR = 1_000_000_000_000;

export function maxRaiseCapEur(network: Network): number {
  return network === "mainnet" ? MAINNET_RAISE_CAP_EUR : TEST_NETWORK_RAISE_CAP_MAX_EUR;
}
