// The highest raise limit an admin can set: the platform default and the
// per-client overrides (POST /api/admin-config/raise-limits and
// /api/clients/raise-limits). Both feed the issuer cap of sale approvals
// (0066 sale_capacity: the most permissive override wins) and the /apply
// check (0056).
//
// On mainnet the existing application and approval workflows enforce the
// standard EUR 3,000,000 ceiling. The sale ledger uses a rolling twelve-month
// window per issuer or its SPV. Higher value issuances require additional
// checks under clause 7; these settings do not increase the standard ceiling.
// SPV caps (spvs.annual_cap_eur) default to EUR 3,000,000 in 0018 and have no
// update route. Other networks retain a higher ceiling for testing.
//
// Import-free apart from a type: client pages and server routes share it.

import type { Network } from "@/lib/network";

/** Maximum configurable raise limit for the standard mainnet workflows (clause 7). */
export const MAINNET_RAISE_CAP_EUR = 3_000_000;

/** The ceiling on devnet, testnet and localnet. */
export const TEST_NETWORK_RAISE_CAP_MAX_EUR = 1_000_000_000_000;

export function maxRaiseCapEur(network: Network): number {
  return network === "mainnet" ? MAINNET_RAISE_CAP_EUR : TEST_NETWORK_RAISE_CAP_MAX_EUR;
}
