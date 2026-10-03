// The UI half of the pilot-scope module switches (lib/features.ts
// pilotModules): which pages and menu entries belong to which module. Pure
// and directive-free, like lib/features.ts; AppShell reads it for the
// navigation, the section tabs and the page notice.
//
// A page is one of two kinds:
//   - "gate": an entry surface only (browse and take OTC offers, vote). With
//     its module off, the page body is replaced by the notice.
//   - "notice": the page also carries exits of existing positions (cancel an
//     offer, withdraw a listing, claim, reclaim a custody deposit). With its
//     module off, the page stays and the notice says new requests are not
//     available; the page hides its entry buttons (moduleEnabled), the entry
//     routes behind it answer 403, and an on-chain entry without a route (an
//     OTC offer, a proposal, an issuance) is refused before the wallet opens
//     (lib/pause-gate.ts MODULE_FLOWS).
// A route listing several modules is off only when all of them are off
// (e.g. "Rights & claims" shows Rights-Token and distribution claims).

import { moduleDisabledMessage, moduleEnabled, PILOT_MODULE_LABELS, type PilotModule } from "@/lib/features";
import { detectNetwork, type Network } from "@/lib/network";

export type ModuleRoute = {
  prefix: string;
  modules: readonly PilotModule[];
  mode: "gate" | "notice";
};

/** Most specific prefix first is not needed: prefixes do not nest ("/issuer/vesting" does not match "/issuer/vesting-series"). */
export const MODULE_ROUTES: readonly ModuleRoute[] = [
  { prefix: "/marketplace/otc", modules: ["secondaryTrading"], mode: "gate" },
  { prefix: "/markets/resell", modules: ["secondaryTrading"], mode: "gate" },
  { prefix: "/marketplace/governance", modules: ["governance"], mode: "gate" },
  { prefix: "/portfolio/governance", modules: ["governance"], mode: "gate" },
  { prefix: "/portfolio/offers", modules: ["secondaryTrading"], mode: "notice" },
  { prefix: "/portfolio/deals", modules: ["secondaryTrading"], mode: "notice" },
  { prefix: "/portfolio/listings", modules: ["secondaryTrading"], mode: "notice" },
  { prefix: "/portfolio/vesting", modules: ["vesting"], mode: "notice" },
  { prefix: "/portfolio/rights", modules: ["rights", "distributions"], mode: "notice" },
  { prefix: "/portfolio/conversion", modules: ["custodyConversion"], mode: "notice" },
  { prefix: "/portfolio/delivery", modules: ["custodyDelivery"], mode: "notice" },
  { prefix: "/issuer/vesting-series", modules: ["vesting"], mode: "notice" },
  // The Rights builder's vesting schedules (api/vesting/create is a rights entry).
  { prefix: "/issuer/vesting", modules: ["rights"], mode: "notice" },
  { prefix: "/admin/otc", modules: ["secondaryTrading"], mode: "notice" },
  { prefix: "/admin/resell", modules: ["secondaryTrading"], mode: "notice" },
  { prefix: "/admin/governance", modules: ["governance"], mode: "notice" },
  { prefix: "/admin/vesting", modules: ["vesting"], mode: "notice" },
  { prefix: "/admin/rights", modules: ["rights"], mode: "notice" },
  // Push distributions, payout schedules and yield routing.
  { prefix: "/admin/payouts", modules: ["distributions"], mode: "notice" },
  { prefix: "/admin/custody", modules: ["custodyConversion", "custodyDelivery"], mode: "notice" },
];

function matches(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export type ModuleRouteState = {
  route: ModuleRoute;
  /** The route's modules that are off (all of them, when the route is off). */
  off: PilotModule[];
  /** True when every module of the route is off. */
  disabled: boolean;
};

/** The module state of `path`, or null for a page outside every module. */
export function moduleRouteState(path: string, network: Network = detectNetwork()): ModuleRouteState | null {
  const route = MODULE_ROUTES.find((r) => matches(path, r.prefix));
  if (!route) return null;
  const off = route.modules.filter((m) => !moduleEnabled(m, network));
  return { route, off, disabled: off.length === route.modules.length };
}

/** False for a menu entry or tab whose page belongs to modules that are all off. */
export function navHrefVisible(href: string, network: Network = detectNetwork()): boolean {
  return !(moduleRouteState(href, network)?.disabled ?? false);
}

/** The sentence a page shows for its switched-off modules ("" when none is off). */
export function moduleNoticeText(state: ModuleRouteState, network: Network = detectNetwork()): string {
  if (state.off.length === 0) return "";
  if (state.off.length === 1) return moduleDisabledMessage(state.off[0], network);
  const labels = state.off.map((m) => PILOT_MODULE_LABELS[m]).join("; ");
  return network === "mainnet"
    ? `${labels}: not available on Solana mainnet.`
    : `${labels}: switched off on Solana ${network}.`;
}

/** The extra line of a notice page: what still works there. */
export const MODULE_EXITS_OPEN =
  "Existing positions can still be closed here: cancels, withdrawals, claims and refunds keep working.";
