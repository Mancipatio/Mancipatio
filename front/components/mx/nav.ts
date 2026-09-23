import { ASSET_TYPES } from "@/lib/asset-types";
import { detectNetwork, type Network } from "@/lib/network";

/**
 * The marketing site's route map — one place, so the header, the footer and
 * every page body agree on where a concept lives.
 *
 * `⚠ NOT BUILT YET` marks routes the structural prototype requires but that
 * do not exist in the app yet. They are wired here on purpose: the pages are
 * being delivered alongside this design system, and a single constant is the
 * only edit needed if a path changes.
 */
export const MX_ROUTES = {
  home: "/",
  /** Owns the six-step issuance flow — nothing else may restate it. */
  howItWorks: "/how-it-works",
  /** The SPV / rights / pledge / recourse page. */
  legalStructure: "/legal-structure",
  /** Practical first-purchase guide; live offerings remain in the app. */
  invest: "/investors",
  /** Plain-language risk disclosure. */
  risks: "/risks",
  instruments: "/markets/types",
  whitepapers: "/markets/whitepapers",
  resell: "/markets/resell",
  marketplace: "/marketplace",
  solutions: "/solutions",
  security: "/security",
  pricing: "/pricing",
  apply: "/apply",
  about: "/about",
  contact: "/contact",
  faq: "/faq",
  terms: "/legal/terms",
  privacy: "/legal/privacy",
} as const;

/** Href of a single instrument fact-sheet page. */
export function instrumentHref(slug: string): string {
  return `${MX_ROUTES.instruments}/${slug}`;
}

export type MxNavItem = { label: string; href: string };

/**
 * The eight instruments, in the curated display order from lib/asset-types.
 * Titles come from that module so the nav can never disagree with the pages.
 */
export const MX_INSTRUMENTS: MxNavItem[] = ASSET_TYPES.map((t) => ({
  label: t.title,
  href: instrumentHref(t.slug),
}));

/**
 * Primary nav, right of the "What we tokenize" dropdown.
 *
 * "Marketplace" is not in the prototype's information architecture — the
 * prototype describes a marketing site, while this one also serves a live
 * marketplace that PublicHeader sits on top of. Without this entry a visitor
 * on /marketplace/launchpad/[sale] has no header route back into the rest of
 * the marketplace, and the marketing site's only door into it is the footer.
 */
export const MX_PRIMARY_NAV: MxNavItem[] = [
  { label: "How it works", href: MX_ROUTES.howItWorks },
  { label: "Legal structure", href: MX_ROUTES.legalStructure },
  { label: "Security", href: MX_ROUTES.security },
  { label: "Whitepapers", href: MX_ROUTES.whitepapers },
  { label: "Pricing", href: MX_ROUTES.pricing },
  { label: "Open app", href: MX_ROUTES.home },
];

/** Footer columns. Marketplace / resell / solutions are appended to
 *  "Platform" so no existing public route becomes unreachable when the
 *  prototype's leaner information architecture takes over the header. */
export const MX_FOOTER_COLUMNS: { title: string; links: MxNavItem[] }[] = [
  { title: "Instruments", links: MX_INSTRUMENTS },
  {
    title: "Platform",
    links: [
      { label: "How it works", href: MX_ROUTES.howItWorks },
      { label: "Compare instruments", href: MX_ROUTES.instruments },
      { label: "Legal structure", href: MX_ROUTES.legalStructure },
      { label: "Security", href: MX_ROUTES.security },
      { label: "Whitepapers", href: MX_ROUTES.whitepapers },
      { label: "Pricing", href: MX_ROUTES.pricing },
      { label: "Solutions", href: MX_ROUTES.solutions },
      { label: "Marketplace", href: MX_ROUTES.marketplace },
      { label: "Resell board", href: MX_ROUTES.resell },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: MX_ROUTES.about },
      { label: "Apply to issue", href: MX_ROUTES.apply },
      { label: "For investors", href: MX_ROUTES.invest },
      { label: "Risk disclosure", href: MX_ROUTES.risks },
      { label: "Contact", href: MX_ROUTES.contact },
      { label: "FAQ", href: MX_ROUTES.faq },
      { label: "Terms", href: MX_ROUTES.terms },
      { label: "Privacy", href: MX_ROUTES.privacy },
    ],
  },
];

/** Deployment stage for `network`: "Solana devnet · v0.1". */
export function mxStageLabel(network: Network): string {
  return `Solana ${network} · v0.1`;
}

/** Deployment stage of THIS build, shown as a badge in the header footprint
 *  and footer. Derived from NEXT_PUBLIC_NETWORK (lib/network.ts), so a
 *  mainnet build never advertises devnet. */
export const MX_STAGE_LABEL = mxStageLabel(detectNetwork());
