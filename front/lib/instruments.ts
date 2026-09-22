import { CATEGORY_SLUGS, type CategorySlug } from "@/lib/asset-types";

/**
 * Public copy for the eight instruments — the comparison table at
 * `/markets/types` and the eight fact-sheet pages at `/markets/types/[slug]`.
 *
 * Ported from *Manci — structural prototype, revision 2*. Two rules from
 * that document govern every value below and are not negotiable:
 *
 * 1. **"Spec notes" never ship.** The prototype's annotation blocks are notes
 *    to us, not content. None of them are here.
 * 2. **An unresolved fact renders as nothing.** No "pending", no "TBD", no
 *    placeholder. A term that is not settled is simply *absent* from `terms`
 *    below — the fact-sheet row disappears and the comparison column is
 *    dropped (see `settledTermKeys`). A dash is reserved for *not applicable*,
 *    which is a real answer.
 *
 * The same rule applies to prose: nothing here states a fact the legal
 * document, the codebase or the prototype does not support. Where an
 * instrument's terms are undecided, the page says less rather than guessing.
 *
 * Slugs are the app's existing category slugs (they drive routes, on-chain
 * asset types and `asset_profiles`); only the displayed copy is new.
 */

/* ────────────────────────────────────────────────────────────────────────
   Terms — the eight legal questions answered identically on every page
   ──────────────────────────────────────────────────────────────────── */

/** Marker for "genuinely not applicable to this instrument" — a settled
 *  answer, rendered as "Not applicable" in a fact sheet and as a dash in the
 *  comparison table. Distinct from *absent*, which means not yet settled. */
export const NOT_APPLICABLE = { na: true } as const;

export type TermValue = string | typeof NOT_APPLICABLE;

export function isNotApplicable(
  value: TermValue | undefined,
): value is typeof NOT_APPLICABLE {
  return value !== undefined && typeof value !== "string";
}

/** The eight fields of the "Terms at a glance" card, in order. Identical on
 *  every instrument page so two pages cannot answer the same question
 *  differently. */
export const TERM_FIELDS = [
  { key: "spv", label: "Serbian SPV" },
  { key: "cap", label: "Annual cap" },
  { key: "distributions", label: "Distributions" },
  { key: "conversion", label: "Conversion" },
  { key: "pledge", label: "Share pledge" },
  { key: "delivery", label: "Delivery" },
  { key: "whitepaper", label: "Whitepaper approval" },
  { key: "recourse", label: "Recourse" },
] as const;

export type TermKey = (typeof TERM_FIELDS)[number]["key"];

export type TermSet = {
  /** Row label in the comparison table and header of the fact-sheet card. */
  title: string;
  /** The right the token carries — the one thing that differs across all
   *  eight, and the reason the comparison table exists. */
  right: string;
  /** Omit a key entirely when the answer is not settled. */
  terms: Partial<Record<TermKey, TermValue>>;
};

/* ────────────────────────────────────────────────────────────────────────
   Page content
   ──────────────────────────────────────────────────────────────────── */

export type InstrumentCta = {
  label: string;
  href: string;
  variant?: "solid" | "ghost";
};

export type FactCard = { heading: string; points: string[] };

export type InstrumentContent = {
  slug: CategorySlug;
  /** Must match `ASSET_TYPES[].title` — the header and footer nav derive
   *  their labels from there, and the two must not drift. */
  label: string;
  headline: string;
  lede: string;
  /** One line, used on the `/markets/types` index cards. */
  blurb: string;
  ctas: InstrumentCta[];
  /** Prose paragraphs under a "What it is" heading. */
  whatItIs?: string[];
  whoItsFor?: string[];
  factSheetEyebrow: string;
  factSheetTitle: string;
  factSheet: FactCard[];
  /** One card per set of terms. Real estate carries two (rental income and
   *  ownership answer differently); "Other" carries none. */
  terms: TermSet[];
  /** Illustrative and generic — never a real counterparty, never a number a
   *  reader could mistake for a minimum. Omitted where the prototype gives
   *  none rather than inventing one. */
  typicalUse?: string;
  /** "What's different about issuing this one". The six shared steps live on
   *  the how-it-works page and are never restated here. */
  differs?: string[];
  /** "If the issuer doesn't perform" — only where recourse is settled. */
  recourse?: string[];
  /** Closing buttons. Rendered under `recourse`, or under `differs` when
   *  there is no recourse section. Empty means no closing CTA. */
  closingCtas: InstrumentCta[];
};

const APPLY: InstrumentCta = { label: "Apply to issue", href: "/apply" };
const COMPARE: InstrumentCta = {
  label: "Compare all eight",
  href: "/markets/types",
  variant: "ghost",
};
const LEGAL_STRUCTURE: InstrumentCta = {
  label: "Read the legal structure",
  href: "/legal-structure",
  variant: "ghost",
};
const TELL_US: InstrumentCta = { label: "Tell us your idea", href: "/contact" };

const EUR_CAP = "EUR 3,000,000 per SPV";

const INSTRUMENTS: Record<CategorySlug, InstrumentContent> = {
  equity: {
    slug: "equity",
    label: "Company ownership",
    headline: "Convertible into real shares",
    lede: "A token carrying the right to become an actual shareholder in your company, issued through a Serbian SPV.",
    blurb: "Convertible into real shares in the company.",
    ctas: [APPLY, COMPARE],
    whatItIs: [
      "Holders buy a token carrying a documented right to become a shareholder, at a time they choose, through the standard legal share-transfer procedure. Where structured that way, the token can also carry dividend or revenue payments.",
    ],
    whoItsFor: [
      "An early-stage company raising without setting a valuation",
      "A company that wants its community on the cap table",
      "A founder who wants token distribution without issuing a token that means nothing",
    ],
    factSheetEyebrow: "Fact sheet",
    factSheetTitle: "What this instrument covers",
    factSheet: [
      {
        heading: "Why convertible",
        points: [
          "Most tokens give holders no real benefit and no share in the business behind them",
          "Even when the business succeeds, a plain token can be worth no more than its liquidity pool",
          "A token convertible into shares lets holders capture the actual upside",
          "That makes buying it closer to traditional investing, with protections that otherwise don't exist here",
        ],
      },
      {
        heading: "Becoming a shareholder",
        points: [
          "Holders can convert at a time of their choosing",
          "Buying the token needs no identity verification unless the class is KYC-gated (then the receiving wallet needs an investor passport); converting into shares requires it (KYC)",
          "Conversion goes through the standard legal share-transfer procedure",
          "If the company or its founders fail to facilitate the transfer, holders have legal recourse",
          "Holders can sell instead of converting — the right travels with the token",
        ],
      },
      {
        heading: "Structure & protections",
        points: [
          "Issued through a Serbian SPV, incorporated for you if you don't have one",
          "Maximum issuance EUR 3 million per year per SPV",
          "A share pledge can be registered for the benefit of token holders",
          "Freely transferable and tradeable",
          "Can carry dividend or revenue payments, structured per issuance",
        ],
      },
    ],
    terms: [
      {
        title: "Company ownership",
        right: "Conversion into company shares",
        terms: {
          spv: "Required",
          cap: EUR_CAP,
          distributions: "Optional · issuer-push",
          conversion: "Yes · off-chain",
          pledge: "Available",
          delivery: NOT_APPLICABLE,
          recourse: "Yes",
        },
      },
    ],
    typicalUse:
      "an early-stage software company raising without setting a valuation.",
    differs: [
      "Issuance follows the same six steps as every standard instrument. Two things are specific here: conversion into shares, and registration of a share pledge in holders' favour. Both happen off-chain, through the legal process.",
    ],
    recourse: [
      "Conversion runs through the standard legal share-transfer procedure, and the holder's right to it is binding on the issuer. If the company or its founders won't facilitate the transfer, the holder has legal recourse against them. The registered share pledge is what makes that recourse worth something.",
    ],
    closingCtas: [APPLY, LEGAL_STRUCTURE],
  },

  debt: {
    slug: "debt",
    label: "Debt instruments",
    headline: "Lend, hold the claim, get repaid",
    lede: "Tokenised bonds and notes. Coupon or zero-coupon, convertible, callable.",
    blurb: "Bonds and notes. Coupon, zero-coupon, convertible, callable.",
    ctas: [APPLY, COMPARE],
    factSheetEyebrow: "Fact sheet",
    factSheetTitle: "What this instrument covers",
    factSheet: [
      {
        heading: "The instrument",
        points: [
          "A corporate bond is simple: you give a company money, and when the term lapses it returns the money and pays interest",
          "Bonds are one of the most basic financial instruments — Manci brings their issuance on-chain",
          "The platform supports bonds and other debt instruments of every kind",
        ],
      },
      {
        heading: "Structuring options",
        points: [
          "Coupon or zero-coupon",
          "Convertible into shares",
          "Callable before maturity",
          "Terms tailored per issuance",
        ],
      },
      {
        heading: "Protections",
        points: [
          "Issued through a Serbian SPV, incorporated for you if you don't have one",
          "Maximum issuance EUR 3 million per year per SPV",
          "Freely transferable and tradeable",
          "If a bond is not paid, holders have legal recourse",
        ],
      },
    ],
    terms: [
      {
        title: "Debt instruments",
        right: "Repayment, with interest where the note carries a coupon",
        terms: {
          spv: "Required",
          cap: EUR_CAP,
          distributions: "Coupon · issuer-push",
          conversion: "Optional",
          delivery: NOT_APPLICABLE,
          recourse: "Yes",
        },
      },
    ],
    differs: [
      "Issuance follows the same six steps. What's specific here is the coupon: the issuer deposits the payment on the agreed schedule, and the contract distributes each holder's share.",
    ],
    recourse: [
      "Repayment is a binding obligation on the issuer, not a discretionary payment. If a bond is not paid, holders have legal recourse.",
    ],
    closingCtas: [APPLY, LEGAL_STRUCTURE],
  },

  real_estate: {
    slug: "real_estate",
    label: "Real estate",
    headline: "Two ways into property",
    lede: "A token that streams rental income to your wallet, or a token carrying the right to acquire ownership itself.",
    blurb: "Rental income, or the right to acquire the property itself.",
    ctas: [APPLY, COMPARE],
    factSheetEyebrow: "Fact sheet",
    factSheetTitle: "What this instrument covers",
    factSheet: [
      {
        heading: "Rental income",
        points: [
          "Rental income is a major driver of real-estate investing — but managing property is much harder work than people think",
          "Buying a whole property is capital-intensive; buying a portion of one is far more achievable",
          "Once the issuer deposits the rent, each holder's portion is distributed to their wallet — monthly or quarterly, set by the instrument",
          "Freely transferable and tradeable",
          "If the issuer avoids paying holders their share of the income, there is legal recourse",
        ],
      },
      {
        heading: "Ownership",
        points: [
          "A token alone cannot make you the registered owner — but it can carry the right to have the property transferred to you at a time of your choosing",
          "Acquiring actual ownership still goes through the regular transfer process",
          "The rental income can sit with the token holder or with the legal owner — this varies per project",
          "Freely transferable and tradeable",
          "If the legal owner fails to facilitate the transfer of ownership, there is legal recourse",
          "Ownership structures are prepared and deployed case by case — there are no standard terms",
        ],
      },
    ],
    terms: [
      {
        title: "Real estate — rental",
        right: "A share of the rental income",
        terms: {
          distributions: "Yes · issuer-push",
          conversion: NOT_APPLICABLE,
          delivery: NOT_APPLICABLE,
          recourse: "Yes",
        },
      },
      {
        title: "Real estate — ownership",
        right: "The right to acquire the property itself",
        terms: {
          spv: "Case by case",
          cap: "Case by case",
          distributions: "Deal term",
          conversion: "Right to acquire",
          delivery: NOT_APPLICABLE,
          recourse: "Yes",
        },
      },
    ],
    differs: [
      "Rental income follows the same six steps as every standard instrument, with the issuer depositing the rent on the agreed schedule — monthly or quarterly.",
      "Ownership has no standard flow. It is structured case by case with the legal team, because a property transfer is a regulated process in its own right.",
    ],
    recourse: [
      "If the issuer avoids paying holders their share of the income, holders have legal recourse. Where the token carries the right to acquire the property and the legal owner won't facilitate the transfer, that right is enforceable against them too.",
    ],
    closingCtas: [APPLY, LEGAL_STRUCTURE],
  },

  royalty: {
    slug: "royalty",
    label: "Royalty rights",
    headline: "Income from intellectual property",
    lede: "Some intellectual property generates revenue on its own. A book sells, then a game or a show gets built on it, and every layer generates income.",
    blurb: "Income from registered intellectual property.",
    ctas: [APPLY, COMPARE],
    factSheetEyebrow: "Fact sheet",
    factSheetTitle: "What this instrument covers",
    factSheet: [
      {
        heading: "Revenue-generating IP",
        points: [
          "Some intellectual property generates revenue all by itself",
          "A book can sell a million copies — then a game or a show gets built on top of it, and every layer generates income",
          "Manci tokenises that income stream",
        ],
      },
      {
        heading: "How holders are paid",
        points: [
          "Once the issuer deposits the income, each holder's portion is distributed to their wallet",
          "Freely transferable and tradeable",
          "If the issuer avoids paying holders their share of the income, there is legal recourse",
        ],
      },
    ],
    terms: [
      {
        title: "Royalty rights",
        right: "A share of the income the intellectual property earns",
        terms: {
          distributions: "Yes · issuer-push",
          conversion: NOT_APPLICABLE,
          delivery: NOT_APPLICABLE,
          recourse: "Yes",
        },
      },
    ],
    differs: [
      "Issuance follows the same six steps. What's specific here is the distribution: the issuer deposits the royalty income on the agreed schedule, and the contract distributes each holder's share.",
    ],
    recourse: [
      "The share of income is a binding obligation on the issuer, not a discretionary payment. If the issuer avoids paying holders their share, holders have legal recourse.",
    ],
    closingCtas: [APPLY, LEGAL_STRUCTURE],
  },

  revenue_share: {
    slug: "revenue_share",
    label: "Revenue share",
    headline: "A defined slice of future revenue",
    lede: "A token carrying the right to a share of a business's revenue over a set period — for example, 0.1% of everything received within three years of issuance.",
    blurb: "A defined percentage of revenue over a defined period.",
    ctas: [APPLY, COMPARE],
    whatItIs: [
      "In traditional finance, investing is ultimately a claim on future revenue — through dividends, or through capital gains that price it in. This instrument tokenises that claim directly.",
    ],
    whoItsFor: [
      "Businesses that expect revenue early rather than after years of build",
      "Operators who want capital without giving up ownership",
      "Projects with clean, auditable revenue a third party can verify",
    ],
    factSheetEyebrow: "Fact sheet",
    factSheetTitle: "What this instrument covers",
    factSheet: [
      {
        heading: "The model",
        points: [
          "Real businesses exist to generate revenue, and most need investment to get there",
          "A token can grant a defined percentage of revenue received within a defined window",
          "Suited to businesses with revenue early — services, operations, content",
        ],
      },
      {
        heading: "Structuring options",
        points: [
          "Limited to a defined period",
          "Payable monthly, quarterly or annually",
          "Can be made convertible into company shares",
          "Can carry a cap expressed as a multiple",
        ],
      },
      {
        heading: "Protections",
        points: [
          "Issued through a Serbian SPV, incorporated for you if you don't have one",
          "Maximum issuance EUR 3 million per year per SPV",
          "A share pledge can be registered for the benefit of token holders",
          "Once the issuer deposits the funds, each holder's portion is distributed automatically to their wallet",
          "Freely transferable and tradeable",
        ],
      },
    ],
    terms: [
      {
        title: "Revenue share",
        right: "A defined share of revenue over a defined period",
        terms: {
          spv: "Required",
          cap: EUR_CAP,
          distributions: "Yes · issuer-push",
          conversion: "Optional",
          pledge: "Available",
          delivery: NOT_APPLICABLE,
          recourse: "Yes",
        },
      },
    ],
    typicalUse:
      "a defined share of revenue from an operating business over three years.",
    differs: [
      "Issuance follows the same six steps. What's specific here is the distribution: the issuer deposits revenue to the contract on the agreed schedule, and the contract distributes each holder's share. The instrument can also be structured as convertible.",
    ],
    recourse: [
      "The revenue share is a binding obligation on the issuer, not a discretionary payment. If the issuer avoids paying holders their share, holders have legal recourse. The share pledge, where registered, is what gives that recourse teeth.",
    ],
    closingCtas: [APPLY, LEGAL_STRUCTURE],
  },

  commodity: {
    slug: "commodity",
    label: "Fungible assets",
    headline: "Interchangeable goods, tokenised",
    lede: "Assets where every unit is the same and any one will do — stored commodities, bottled output, tickets.",
    blurb: "Interchangeable goods, from stored commodities to tickets.",
    ctas: [APPLY, COMPARE],
    factSheetEyebrow: "Fact sheet",
    factSheetTitle: "What this instrument covers",
    factSheet: [
      {
        heading: "What fungible means",
        points: [
          "Fungible assets can be substituted with like assets — buying a chocolate bar, you don't care which one from the shelf",
          "Most commodities and securities are fungible: one share of a company is the same as another",
          "Bitcoin, ETH and most cryptocurrencies are fungible too",
        ],
      },
      {
        heading: "What can be tokenised",
        points: [
          "Most asset types, from stored grain to concert tickets",
          "Tokenised assets are freely transferable and tradeable",
        ],
      },
      {
        heading: "Physical delivery",
        points: [
          "Deliverable assets can be redeemed: deposit the tokens into escrow, receive the goods, and the tokens are burned on confirmed delivery",
          "If a delivery is cancelled, the tokens are returned to the holder",
          "Redemption requires identity verification (KYC); buying and trading the token do not, unless the class is KYC-gated",
          "Manci doesn't handle the logistics, but a delivery arrangement can be set up alongside us",
        ],
      },
    ],
    terms: [
      {
        title: "Fungible assets",
        right: "Delivery of the goods themselves",
        terms: {
          distributions: NOT_APPLICABLE,
          conversion: NOT_APPLICABLE,
          pledge: NOT_APPLICABLE,
          delivery: "Deposit → confirm → burn",
        },
      },
    ],
    typicalUse:
      "a stored agricultural commodity, or bottled output from a producer.",
    differs: [
      "Issuance follows the same six steps. What's specific here is redemption: an identity-verified holder deposits the tokens into escrow, and once delivery is confirmed the tokens are burned. If the delivery is cancelled they're returned. We don't move the goods ourselves.",
      "Transfers are not restricted and buying needs no identity verification, so a token can reach a wallet that has not verified. That wallet can hold and sell it, but cannot redeem it until its holder completes identity verification (KYC).",
    ],
    closingCtas: [APPLY, LEGAL_STRUCTURE],
  },

  physical: {
    slug: "physical",
    label: "Non-fungible assets",
    headline: "Unique items, tokenised",
    lede: "Assets where you care exactly which one you get — artworks, vehicles, individual pieces.",
    blurb: "Unique items. Artworks, vehicles, individual pieces.",
    ctas: [APPLY, COMPARE],
    factSheetEyebrow: "Fact sheet",
    factSheetTitle: "What this instrument covers",
    factSheet: [
      {
        heading: "What non-fungible means",
        points: [
          "Non-fungible assets cannot be substituted with like assets — buying a used car, you inspect that exact car, because every one is in a different state",
          "Most art is non-fungible: which exact painting you get matters, and even the same artist isn't enough",
          "NFTs are usually non-fungible — although, despite the name, some are actually fungible",
        ],
      },
      {
        heading: "What can be tokenised",
        points: [
          "Most asset types, from art pieces to used cars",
          "Tokenised assets are freely transferable and tradeable",
        ],
      },
      {
        heading: "Physical delivery",
        points: [
          "Deliverable assets can be redeemed: deposit the token into escrow, receive the item, and the token is burned on confirmed delivery",
          "If a delivery is cancelled, the token is returned to the holder",
          "Redemption requires identity verification (KYC); buying and trading the token do not, unless the class is KYC-gated",
          "Manci doesn't handle the logistics, but a delivery arrangement can be set up alongside us",
        ],
      },
    ],
    terms: [
      {
        title: "Non-fungible assets",
        right: "Delivery of the specific item",
        terms: {
          distributions: NOT_APPLICABLE,
          conversion: NOT_APPLICABLE,
          pledge: NOT_APPLICABLE,
          delivery: "Deposit → confirm → burn",
        },
      },
    ],
    differs: [
      "Issuance follows the same six steps. What's specific here is redemption: an identity-verified holder deposits the token into escrow, and once delivery is confirmed the token is burned. If the delivery is cancelled it's returned. We don't move the item ourselves.",
      "Transfers are not restricted and buying needs no identity verification, so a token can reach a wallet that has not verified. That wallet can hold and sell it, but cannot redeem it until its holder completes identity verification (KYC).",
    ],
    closingCtas: [APPLY, LEGAL_STRUCTURE],
  },

  other: {
    slug: "other",
    label: "Other",
    headline: "Something the eight don't cover",
    lede: "Tokenisation infrastructure for rights, services, platform utility — anything that needs a token with an enforceable claim behind it.",
    blurb: "Something the eight don't cover. Tell us what you have.",
    ctas: [TELL_US],
    factSheetEyebrow: "Bespoke structuring",
    factSheetTitle: "What we offer, and how to start",
    factSheet: [
      {
        heading: "What we offer",
        points: [
          "The technology can be used in ways the main instruments don't cover",
          "The technology tokenises the asset; the legal team makes the token rights binding on the issuer",
          "Bespoke technical and legal structuring, designed around your idea",
        ],
      },
      {
        heading: "How to start",
        points: [
          "Tell us about the idea",
          "We evaluate it and propose a structure",
          "If we agree, we build a dedicated process together",
        ],
      },
    ],
    // No standard flow and no standard terms: bespoke work is designed per
    // engagement, so this page states nothing about SPVs, caps or recourse.
    terms: [],
    closingCtas: [],
  },
};

/** The eight instruments in the app's canonical display order. */
export const INSTRUMENT_LIST: InstrumentContent[] = CATEGORY_SLUGS.map(
  (slug) => INSTRUMENTS[slug],
);

/** Lookup by URL segment. Deliberately a `find` and not an index into the
 *  record: a request for `/markets/types/constructor` must 404, not resolve to
 *  something off `Object.prototype`. */
export function instrumentBySlug(slug: string): InstrumentContent | undefined {
  return INSTRUMENT_LIST.find((instrument) => instrument.slug === slug);
}

/* ────────────────────────────────────────────────────────────────────────
   Comparison table
   ──────────────────────────────────────────────────────────────────── */

/** Every term set, in display order. Real estate contributes two (rental and
 *  ownership answer differently); "Other" contributes none. */
export const COMPARISON_SETS: TermSet[] = INSTRUMENT_LIST.flatMap(
  (i) => i.terms,
);

/**
 * The term columns that are settled for *every* row.
 *
 * A comparison table forces a claim into every cell, so a column with a gap
 * in it cannot be published: a blank reads as "no" and a dash means "not
 * applicable", and neither is true of an open question. Columns that are not
 * settled across the board are dropped here and stated as prose elsewhere,
 * naming the instruments they actually apply to.
 */
export function settledTermKeys(): TermKey[] {
  return TERM_FIELDS.filter((f) =>
    COMPARISON_SETS.every((s) => s.terms[f.key] !== undefined),
  ).map((f) => f.key);
}

export function termLabel(key: TermKey): string {
  return TERM_FIELDS.find((f) => f.key === key)?.label ?? key;
}

/**
 * The legal anchors that *are* settled, each traceable to a value above:
 * `spv` / `cap` on equity, debt and revenue share; `pledge` on equity and
 * revenue share; `delivery` on the two deliverable instruments; `recourse`
 * wherever it is answered. Nothing here claims anything about an instrument
 * it does not name.
 */
export const SETTLED_ANCHORS: string[] = [
  "Company ownership, debt instruments and revenue share are issued through a Serbian SPV",
  "EUR 3,000,000 maximum issuance per SPV per year",
  "A share pledge can be registered for company ownership and revenue share",
  "Property ownership is structured case by case with the legal team",
  "Fungible and non-fungible assets are redeemed by deposit, confirmation and burn",
  "Legal recourse against the issuer on every instrument that pays or converts",
];
