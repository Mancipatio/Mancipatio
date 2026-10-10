// Statements about which product modules are live, for marketing pages that
// render on every network (the About page's "Where things stand"). A module
// that is switched off on the build's network (on mainnet, unless its
// NEXT_PUBLIC_FEATURE_* variable is on: lib/features.ts, Terms clause 2) is
// named as built, never as shipped or live, so the line stays true before
// and after a module is switched on.

import { moduleEnabled, type PilotModule } from "@/lib/features";
import type { Network } from "@/lib/network";

/** The modules the About page names, each behind its switch. */
const SHIPPED_MODULES: ReadonlyArray<readonly [string, PilotModule]> = [
  ["OTC settlement", "secondaryTrading"],
  ["conversion into company shares", "custodyConversion"],
  ["governance", "governance"],
  ["vesting", "vesting"],
];

function joinList(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function modulesFact(network: Network): string {
  const on = SHIPPED_MODULES.filter(([, module]) => moduleEnabled(module, network)).map(([label]) => label);
  const off = SHIPPED_MODULES.filter(([, module]) => !moduleEnabled(module, network)).map(([label]) => label);
  if (off.length === 0) return `${joinList(["Launchpad", ...on])} shipped`;
  return `${joinList(["Launchpad", ...on])} live; ${joinList(off)} built, not available on Solana ${network}`;
}
