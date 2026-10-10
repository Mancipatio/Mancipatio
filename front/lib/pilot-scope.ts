// The UI half of the pilot-scope module switches (lib/features.ts
// pilotModules): which pages and menu entries belong to which module. Pure
// and directive-free, like lib/features.ts; AppShell reads it for the
// navigation, the section tabs and the page notice, and navHrefVisible hides
// the admin menu entries, cards, CTAs and footer links of switched-off
// modules everywhere else (devnet shows everything: modules default on).
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
//
// KYC-only mode (lib/features.ts kycOnly) adds its own table, KYC_ONLY_ROUTES:
// the pages of the two core areas it pauses (primary sales and issuance),
// with the same two kinds. It is consulted before MODULE_ROUTES and ONLY
// while the mode is on (the most specific entry wins), so with the mode off
// it adds no notice and hides nothing; the module pages need no entry there,
// since the mode turns every module off. Its notice says "Paused." (the
// Terms offer primary sales and issuance), a module page keeps "Not
// available.", and both say the one KYC_ONLY_MESSAGE.
//
// Offered asset classes (lib/asset-classes.ts): every public list of asset
// classes (the overview tiles, the marketplace and whitepaper filters,
// /markets/types, the footer and the contact form) shows only
// offeredAssetClasses(), and
// navHrefVisible hides a link to the guide of a class that is not offered
// (/markets/types/<slug>, /markets/<slug>); the page itself stays reachable
// by URL with a notice. Data of existing assets is never filtered.

import {
  features,
  kycOnly,
  KYC_ONLY_MESSAGE,
  moduleEnabled,
  SCOPE_LABELS,
  scopeDisabledMessage,
  scopeEnabled,
  type FeatureName,
  type PilotModule,
  type ScopeName,
} from "@/lib/features";
import { ASSET_CLASS_SLUGS, offeredAssetClassesFor, type AssetClassSlug } from "@/lib/asset-classes";
import { detectNetwork, type Network } from "@/lib/network";

export type ModuleRoute = {
  prefix: string;
  modules: readonly ScopeName[];
  mode: "gate" | "notice";
  /** Only this path, not its subpaths (KYC_ONLY_ROUTES). */
  exact?: boolean;
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

/**
 * KYC-only mode (lib/features.ts kycOnly): its pages, consulted before
 * MODULE_ROUTES and only while the mode is on. The most specific entry wins
 * (an exact entry over a prefix, then the longest prefix). Not listed, on
 * purpose: /issuer/authority and /issuer/recovery (operator tools),
 * /issuer/rotation (its own flag), /issuer/vesting* (module pages, off with
 * every module), and everything a verification request or the portfolio uses.
 */
export const KYC_ONLY_ROUTES: readonly ModuleRoute[] = [
  // Primary sales: the list is replaced by the notice; a sale page keeps its
  // information and the recovery of a purchase that already landed ("Retry
  // recording"), and shows no buy or commit form.
  { prefix: "/marketplace/launchpad", exact: true, modules: ["primarySales"], mode: "gate" },
  { prefix: "/marketplace/launchpad", modules: ["primarySales"], mode: "notice" },
  // Issuance entries only: the raise application, issuer registration,
  // tokenization and share classes (the operator's own tools are on /admin).
  { prefix: "/apply", modules: ["issuance"], mode: "gate" },
  { prefix: "/issuer/onboarding", modules: ["issuance"], mode: "gate" },
  { prefix: "/issuer/assets/tokenize", modules: ["issuance"], mode: "gate" },
  { prefix: "/issuer/share-classes", modules: ["issuance"], mode: "gate" },
  // Pages that also carry the read view and exits of what exists (withdraw a
  // sale request, end a sale and collect, take a profile down, a payout
  // vault's release): the notice, with the entry buttons hidden.
  { prefix: "/issuer", exact: true, modules: ["issuance"], mode: "notice" },
  { prefix: "/issuer/assets", modules: ["issuance"], mode: "notice" },
  { prefix: "/issuer/launchpad", modules: ["primarySales", "issuance"], mode: "notice" },
  { prefix: "/issuer/payouts", modules: ["issuance"], mode: "notice" },
];

/** KYC-only mode: guides of what it pauses leave every menu (the pages stay, without a notice). */
export const KYC_ONLY_NAV_PREFIXES: readonly string[] = [
  "/solutions/issuer-registry", "/solutions/tokenization", "/solutions/share-classes", "/solutions/launchpad",
];

function matches(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function routeMatches(path: string, r: ModuleRoute): boolean {
  return r.exact ? path === r.prefix : matches(path, r.prefix);
}

/** The most specific KYC_ONLY_ROUTES entry for `path` (an exact entry over a prefix, then the longest prefix), or null. */
export function kycOnlyRoute(path: string): ModuleRoute | null {
  let best: ModuleRoute | null = null;
  let bestScore = -1;
  for (const r of KYC_ONLY_ROUTES) {
    if (!routeMatches(path, r)) continue;
    const score = r.prefix.length * 2 + (r.exact ? 1 : 0);
    if (score > bestScore) { best = r; bestScore = score; }
  }
  return best;
}

export type ModuleRouteState = {
  route: ModuleRoute;
  /** The route's modules (or core areas) that are off (all of them, when the route is off). */
  off: ScopeName[];
  /** True when every module of the route is off. */
  disabled: boolean;
  /** True for a page of KYC-only mode's own table (KYC_ONLY_ROUTES): its notice says "Paused.". */
  kyc: boolean;
};

/** The module state of `path`, or null for a page outside every module. */
export function moduleRouteState(path: string, network: Network = detectNetwork()): ModuleRouteState | null {
  if (kycOnly(network)) {
    const locked = kycOnlyRoute(path);
    if (locked) return { route: locked, off: [...locked.modules], disabled: true, kyc: true };
  }
  const route = MODULE_ROUTES.find((r) => routeMatches(path, r));
  if (!route) return null;
  const off = route.modules.filter((m) => !scopeEnabled(m, network));
  return { route, off, disabled: off.length === route.modules.length, kyc: false };
}

/**
 * Menu-only scope: pages that are not module pages above (no notice is added
 * to them) but whose menu entries, tabs, cards and links still follow a
 * switch: the public guide of a module, or a page that belongs to a
 * features() flag (lib/features.ts). An entry is hidden when every module and
 * flag it lists is off; the page itself stays reachable by its URL.
 */
export type NavRoute = {
  prefix: string;
  modules: readonly PilotModule[];
  features: readonly FeatureName[];
};

export const NAV_ROUTES: readonly NavRoute[] = [
  // Startup payout vaults (startupRaises) and the push distributions listed beside them.
  { prefix: "/issuer/payouts", modules: ["distributions"], features: ["startupRaises"] },
  // The public guides of the modules (/docs "Platform guides", /how-it-works, /faq).
  { prefix: "/solutions/otc", modules: ["secondaryTrading"], features: [] },
  { prefix: "/solutions/governance", modules: ["governance"], features: [] },
  { prefix: "/solutions/rights-vesting", modules: ["rights", "vesting", "distributions"], features: [] },
  { prefix: "/solutions/custody", modules: ["custodyConversion", "custodyDelivery"], features: [] },
];

/**
 * False for a menu entry, tab, card or link whose page belongs only to
 * switched-off modules (MODULE_ROUTES, NAV_ROUTES). A query or hash in `href`
 * is ignored ("/markets/resell?type=equity" is the resell board).
 */
export function navHrefVisible(href: string, network: Network = detectNetwork()): boolean {
  const path = href.split(/[?#]/, 1)[0];
  if (moduleRouteState(path, network)?.disabled) return false;
  if (kycOnly(network) && KYC_ONLY_NAV_PREFIXES.some((p) => matches(path, p))) return false;
  if (!assetClassPathVisible(path, network)) return false;
  const nav = NAV_ROUTES.find((r) => matches(path, r.prefix));
  if (!nav) return true;
  const flags = features(network);
  return nav.modules.some((m) => moduleEnabled(m, network)) || nav.features.some((f) => flags[f]);
}

/**
 * KYC-only mode: hides a link into what the mode pauses. The filter for
 * shared components that never filtered links (mx Button and TextLink):
 * exactly today's behaviour while the mode is off.
 */
export function kycOnlyHides(href: string, network: Network = detectNetwork()): boolean {
  return kycOnly(network) && !navHrefVisible(href, network);
}

/** The sentence a page shows for its switched-off modules ("" when none is off). */
export function moduleNoticeText(state: ModuleRouteState, network: Network = detectNetwork()): string {
  if (state.off.length === 0) return "";
  if (kycOnly(network)) return KYC_ONLY_MESSAGE;
  if (state.off.length === 1) return scopeDisabledMessage(state.off[0], network);
  const labels = state.off.map((m) => SCOPE_LABELS[m]).join("; ");
  return network === "mainnet"
    ? `${labels}: not available on Solana mainnet.`
    : `${labels}: switched off on Solana ${network}.`;
}

/** The extra line of a notice page: what still works there. */
export const MODULE_EXITS_OPEN =
  "Existing positions can still be closed here: cancels, withdrawals, claims and refunds keep working.";

// ── Offered asset classes (lib/asset-classes.ts) ──────────────────────────

/** The asset classes offered on `network`, in display order. */
export function offeredAssetClasses(network: Network = detectNetwork()): readonly AssetClassSlug[] {
  // Literal process.env.NEXT_PUBLIC_* read so Next inlines it client-side.
  return offeredAssetClassesFor(network, process.env.NEXT_PUBLIC_ASSET_CLASSES);
}

/** True when the class `slug` (lib/asset-types.tsx CATEGORY_SLUGS) is offered on `network`. */
export function assetClassOffered(slug: string, network: Network = detectNetwork()): boolean {
  return (offeredAssetClasses(network) as readonly string[]).includes(slug);
}

/** True when every class is offered (public copy that names "every class" stays as it is). */
export function allAssetClassesOffered(network: Network = detectNetwork()): boolean {
  return offeredAssetClasses(network).length === ASSET_CLASS_SLUGS.length;
}

/**
 * False for the guide of a class that is not offered (/markets/types/<slug>,
 * /markets/<slug>); every other path, including /markets/types,
 * /markets/resell and /markets/whitepapers, is not a class page.
 */
export function assetClassPathVisible(path: string, network: Network = detectNetwork()): boolean {
  const slug = /^\/markets\/(?:types\/)?([a-z_]+)$/.exec(path)?.[1];
  if (!slug || !(ASSET_CLASS_SLUGS as readonly string[]).includes(slug)) return true;
  return assetClassOffered(slug, network);
}

/** The page of a class that is not offered (reachable by URL, noindex). */
export const ASSET_CLASS_NOT_OFFERED = "This asset class is not offered on Manci at the moment.";

/** The non-interactive tile or card after the offered classes. */
export const MORE_ASSET_CLASSES_LATER = "More asset classes coming later";
