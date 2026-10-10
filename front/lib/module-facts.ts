// Statements about which product modules are live, for marketing pages that
// render on every network (the About page's "Where things stand"). A module
// that is switched off on the build's network (on mainnet, unless its
// NEXT_PUBLIC_FEATURE_* variable is on: lib/features.ts, Terms clause 2) is
// named as built, never as shipped or live. In KYC-only mode the launchpad
// and issuer applications are named as paused.

import { kycOnly, moduleEnabled, type PilotModule } from "@/lib/features";
import type { Network } from "@/lib/network";

/** The modules the About page names, each behind its switch. */
const SHIPPED_MODULES: ReadonlyArray<readonly [string, PilotModule]> = [
  ["OTC settlement", "secondaryTrading"],
  ["governance", "governance"],
  ["vesting", "vesting"],
];

function joinList(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function modulesFact(network: Network): string {
  // KYC-only mode (lib/features.ts): the launchpad and issuer applications
  // are paused (the Terms offer them), the other modules are not offered on
  // this network yet.
  if (kycOnly(network)) {
    return `Sign-up and identity verification open; launchpad and issuer applications paused for now; ${joinList(SHIPPED_MODULES.map(([label]) => label))} built, not available on Solana ${network}`;
  }
  const on = SHIPPED_MODULES.filter(([, module]) => moduleEnabled(module, network)).map(([label]) => label);
  const off = SHIPPED_MODULES.filter(([, module]) => !moduleEnabled(module, network)).map(([label]) => label);
  if (off.length === 0) return "Launchpad, OTC settlement, governance and vesting shipped";
  return `${joinList(["Launchpad", ...on])} live; ${joinList(off)} built, not available on Solana ${network}`;
}
