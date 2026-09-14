import type { ReactNode } from "react";
import {
  IconBox,
  IconBuilding,
  IconCoins,
  IconLayers,
  IconLock,
  IconRepeat,
  IconScale,
  IconStar,
} from "@/components/icons";
import { AssetType } from "@/lib/generated/asset_registry";

export type AssetTypeRecord = {
  enumValue: AssetType;
  slug: string;
  code: string;
  title: string;
  oneLine: string;
  /** One hard fact from the business doc's fact sheet — shown wherever all
   *  eight categories are listed together (nav dropdown, homepage grid). */
  fact: string;
  encoded: string[];
  example: string;
  icon: ReactNode;
  factSheet: {
    lead: string;
    sections: { heading: string; points: string[] }[];
  };
  /** Public "How issuance works" steps rendered on the category fact-sheet
   *  page — the plain-language flow from onboarding to trading. */
  flow: string[];
};

/** Input kinds for the category-specific create/manage sub-forms.
 *  - "number": stored as-is into a numeric column
 *  - "bps":    UI enters a percent (5 → stored 500 in a *_bps int column)
 *  - "mult":   UI enters a multiple (1.5 → stored 15000 in a *_bps int column) */
export type FieldType =
  | "text"
  | "textarea"
  | "number"
  | "bps"
  | "mult"
  | "date"
  | "boolean"
  | "select";

export type FieldDef = {
  /** matches the asset_profiles column name */
  key: string;
  label: string;
  type: FieldType;
  help?: string;
  placeholder?: string;
  options?: string[];
  /** Default for boolean fields whose DB column defaults non-false (e.g. a
   *  real_estate KYB gate). Used to seed the edit form so opening + saving an
   *  untouched field doesn't silently flip the stored default. */
  default?: boolean;
};

/** The 8 category slugs — single source of truth for the asset_profiles CHECK
 *  constraint. This is the curated *display* order (filter chips, lists); the
 *  on-chain AssetType enum order differs and is mapped via slugForEnum/
 *  enumForSlug (find-by-enumValue, order-independent). */
export const CATEGORY_SLUGS = [
  "equity",
  "debt",
  "real_estate",
  "royalty",
  "revenue_share",
  "commodity",
  "physical",
  "other",
] as const;
export type CategorySlug = (typeof CATEGORY_SLUGS)[number];

/** Shared "How issuance works" steps. Every category starts the same way;
 *  the SPV step is inserted where Serbian law requires one, and each
 *  category appends its own ending (payouts, delivery, conversion…). */
const FLOW_ONBOARD = "Onboard with KYC and accept the Terms of Service.";
// Equity launchpad raises have a self-serve application wizard (/apply); every
// other asset category is scoped with the team via the contact form, which
// feeds the same review. Keep these accurate so no page promises a universal
// on-platform form that only equity actually has.
const FLOW_FORM = "Submit the launchpad application (equity raises).";
const FLOW_FORM_CONTACT =
  "Submit your project through the contact form — the team scopes and structures it with you.";
const FLOW_REVIEW =
  "Compliance review — we approve, request changes, or decline. You can revise and resubmit until it is approved.";
const FLOW_SPV =
  "A Serbian SPV is incorporated for you if you don't already have one.";
const FLOW_MINT =
  "Tokens are minted to the issuer's treasury and distributed from there (to you, or sold via the launchpad).";
const FLOW_TRADE =
  "Trade freely — transfer to any wallet, post on the resell board, and settle through the OTC escrow.";
const FLOW_PAYOUT =
  "When a payout is due, the issuer funds it and every holder wallet automatically receives its proportionate share.";
const FLOW_DELIVERY =
  "Request delivery — deposit your tokens into escrow; they're returned if the delivery is cancelled and burned once delivery is confirmed.";

export const ASSET_TYPES: AssetTypeRecord[] = [
  {
    enumValue: AssetType.Equity,
    slug: "equity",
    code: "EQUITY",
    title: "Company ownership",
    oneLine: "Shares of an incorporated entity with rights and preferences.",
    encoded: ["Vote", "Dividend", "Liquidation preference", "Hard supply cap"],
    fact: "Convertible into real company shares · max EUR 3M per SPV/year",
    example: "Acme Industries pre-IPO Series A",
    icon: <IconBuilding />,
    factSheet: {
      lead: "Convertible tokens that turn token holders into real shareholders — traditional-investor protections, delivered on-chain.",
      sections: [
        {
          heading: "Why convertible",
          points: [
            "Most tokens on the market give holders no real benefit and no share in the startup behind them",
            "Even when the startup succeeds, plain tokens can be worth no more than their liquidity pool — holders end up bag holders",
            "A token convertible into the company's shares lets holders capture the full upside of the startup's success",
            "That makes buying the token akin to traditional investing, with benefits and protections that otherwise don't exist in Web3",
          ],
        },
        {
          heading: "Becoming a shareholder",
          points: [
            "Holders can become actual shareholders at a time of their choosing",
            "Conversion goes through the standard legal share-transfer procedure",
            "If the company or its founders fail to facilitate the transfer, holders have legal recourse",
          ],
        },
        {
          heading: "Structure & protections",
          points: [
            "Issued through a Serbian SPV — incorporated for you if you don't have one",
            "Maximum issuance of EUR 3 million per year per SPV",
            "A share pledge can be registered for the benefit of token holders",
            "Freely transferable and tradeable",
            "Can carry dividend or revenue payments, structured per issuance",
            "Startup raises settle through an escrowed payout vault: revenue routed through the vault is split 1/3 founder · 1/3 investor pool · 1/3 platform; proceeds unlock monthly against posted progress updates, and investors can freeze and vote after 3 missed updates",
          ],
        },
      ],
    },
    flow: [
      FLOW_ONBOARD,
      FLOW_FORM,
      FLOW_REVIEW,
      FLOW_SPV,
      FLOW_MINT,
      FLOW_TRADE,
      "Register a share pledge in your favour, and convert into real shares at a time of your choosing — conversion is initiated through the platform's conversion-request flow (deposit into a conversion vault, then burn + on-chain attestation); the legal share transfer itself remains off-chain.",
    ],
  },
  {
    enumValue: AssetType.Debt,
    slug: "debt",
    code: "DEBT",
    title: "Debt instruments",
    oneLine:
      "On-chain notes — principal + coupon + maturity, terms enforced by the program.",
    encoded: ["Principal", "Coupon rate", "Maturity", "Default trigger"],
    fact: "Principal repaid with interest — legal recourse on default",
    example: "$5M senior note, 8% coupon, 36 months",
    icon: <IconCoins />,
    factSheet: {
      lead: "Tokenized bonds and notes — lend to a company, hold the claim as a token, get repaid with interest.",
      sections: [
        {
          heading: "The instrument",
          points: [
            "A corporate bond is simple: you give a company money, and when the term lapses it returns the money and pays interest",
            "Bonds are one of the most basic financial instruments — Mancipatio brings their issuance on-chain",
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
            "Issued through a Serbian SPV — incorporated for you if you don't have one",
            "Maximum issuance of EUR 3 million per year per SPV",
            "Freely transferable and tradeable",
            "If a bond is not paid, holders have legal recourse",
          ],
        },
      ],
    },
    flow: [
      FLOW_ONBOARD,
      FLOW_FORM_CONTACT,
      FLOW_REVIEW,
      FLOW_SPV,
      FLOW_MINT,
      FLOW_TRADE,
      FLOW_PAYOUT,
    ],
  },
  {
    enumValue: AssetType.RealEstate,
    slug: "real_estate",
    code: "REAL ESTATE",
    title: "Real estate",
    oneLine:
      "Fractional ownership of property, custodied through a special-purpose vehicle.",
    encoded: [
      "SPV reference",
      "Square meters",
      "Income share",
      "KYB-gated transfers",
    ],
    fact: "Rental income streamed to holder wallets monthly or quarterly",
    example: "Downtown Belgrade office building",
    icon: <IconLayers />,
    factSheet: {
      lead: "Two ways into property: a token that streams rental income to your wallet, or a token that carries the right to acquire ownership itself.",
      sections: [
        {
          heading: "Rental income",
          points: [
            "Rental income is a major driver of real-estate investing — but managing property is much harder work than people think",
            "Buying a whole property is capital-intensive; buying a portion of one is far more achievable",
            "Mancipatio tokenises rental income streams — a portion of the income is sent to holder wallets monthly or quarterly",
            "Freely transferable and tradeable",
            "If the issuer avoids paying holders their share of the income, there is legal recourse",
          ],
        },
        {
          heading: "Ownership",
          points: [
            "Tokenising actual ownership has been the dream of RWA projects since the beginning — the obstacles are legal, because real-estate transfers are heavily regulated",
            "A token alone cannot make you the registered owner — but it can carry the right to have the property transferred to you at a time of your choosing",
            "Acquiring actual ownership still goes through the regular transfer process",
            "The rental income can sit with the token holder or with the legal owner — this varies per project",
            "Freely transferable and tradeable",
            "If the legal owner fails to facilitate the transfer of ownership, there is legal recourse",
            "Ownership structures are prepared and deployed case-by-case",
          ],
        },
      ],
    },
    flow: [
      FLOW_ONBOARD,
      FLOW_FORM_CONTACT,
      FLOW_REVIEW,
      FLOW_MINT,
      FLOW_TRADE,
      FLOW_PAYOUT,
      "Ownership tokenization — the right to acquire the property itself — is structured and deployed case-by-case with our legal team.",
    ],
  },
  {
    enumValue: AssetType.Royalty,
    slug: "royalty",
    code: "ROYALTY",
    title: "Royalty rights",
    oneLine:
      "A claim on future royalty streams from a specific revenue source.",
    encoded: ["Royalty rate", "Underlying contract", "Termination date"],
    fact: "IP revenue automatically shared to holder wallets",
    example: "Anthology Vol. 5 publishing royalty",
    icon: <IconStar />,
    factSheet: {
      lead: "Tokenized income from intellectual property — the revenue a book, song or franchise keeps generating, streamed to token holders.",
      sections: [
        {
          heading: "Revenue-generating IP",
          points: [
            "Some intellectual property generates revenue all by itself",
            "A book can sell a million copies — then a game (The Witcher) or a show (Game of Thrones) gets built on top of it, and every layer generates income",
            "Mancipatio tokenises that income stream",
          ],
        },
        {
          heading: "How holders are paid",
          points: [
            "A portion of the income lands automatically in holder wallets",
            "Freely transferable and tradeable",
            "If the issuer avoids paying holders their share of the income, there is legal recourse",
          ],
        },
      ],
    },
    flow: [
      FLOW_ONBOARD,
      FLOW_FORM_CONTACT,
      FLOW_REVIEW,
      FLOW_MINT,
      FLOW_TRADE,
      FLOW_PAYOUT,
    ],
  },
  {
    enumValue: AssetType.RevenueShare,
    slug: "revenue_share",
    code: "REVENUE SHARE",
    title: "Revenue share",
    oneLine:
      "Percentage of gross or net revenue from a business or product line.",
    encoded: ["Revenue %", "Cap (multiple)", "Trigger threshold"],
    fact: "A slice of future revenue — e.g. 0.1% for three years",
    example: "5% of SaaS MRR capped at 3x principal",
    icon: <IconRepeat />,
    factSheet: {
      lead: "A token that carries a right to a share of a project's future revenue — for example, 0.1% of all revenue received within three years of issuance.",
      sections: [
        {
          heading: "The model",
          points: [
            "Real projects exist to generate revenue — and most need investment to get there",
            "In traditional finance, investing is ultimately a claim on future revenue, whether through dividends or capital gains",
            "Mancipatio tokenises that claim directly: a token can grant, say, 0.1% of all revenue received within three years of issuance",
            "Ideal for projects that expect revenue early — YouTube channels, outsourcing companies, fast-food restaurants",
          ],
        },
        {
          heading: "Structuring options",
          points: [
            "Limited to a defined period",
            "Payable monthly, quarterly or annually",
            "Can even be convertible into company shares",
          ],
        },
        {
          heading: "Protections",
          points: [
            "Issued through a Serbian SPV — incorporated for you if you don't have one",
            "Maximum issuance of EUR 3 million per year per SPV",
            "A share pledge can be registered for the benefit of token holders",
            "Holders automatically receive their portion of revenue in their wallets",
            "Freely transferable and tradeable",
            "If the issuer avoids paying holders their share of the revenue, there is legal recourse",
          ],
        },
      ],
    },
    flow: [
      FLOW_ONBOARD,
      FLOW_FORM_CONTACT,
      FLOW_REVIEW,
      FLOW_SPV,
      FLOW_MINT,
      FLOW_TRADE,
      FLOW_PAYOUT,
    ],
  },
  {
    enumValue: AssetType.Commodity,
    slug: "commodity",
    code: "FUNGIBLE",
    title: "Fungible assets",
    oneLine:
      "Interchangeable assets — commodities, securities, tickets — where every unit is the same.",
    encoded: ["Underlying", "Storage proof ref", "Settlement window"],
    fact: "Interchangeable goods — delivery burns the tokens",
    example: "1 kg of LBMA-grade gold, vaulted in Zurich",
    icon: <IconScale />,
    factSheet: {
      lead: "Tokenisation of interchangeable assets — where every unit is the same, from commodities to concert tickets.",
      sections: [
        {
          heading: "What fungible means",
          points: [
            "Fungible assets can be substituted with like assets — when you buy a chocolate bar, you don't care which one from the shelf you get",
            "Most commodities and securities are fungible: a Tesla share is a Tesla share",
            "Bitcoin, ETH and most cryptos are fungible too",
          ],
        },
        {
          heading: "What can be tokenized",
          points: [
            "Most asset types can be tokenized — from wheat to concert tickets",
            "Tokenized assets are freely transferable and tradeable",
          ],
        },
        {
          heading: "Physical delivery",
          points: [
            "Deliverable assets can be redeemed through the platform: deposit the tokens into escrow, receive the goods, and the tokens are burned on confirmed delivery",
            "If a delivery is cancelled, the tokens are returned to the holder",
            "Mancipatio doesn't handle the logistics itself, but the delivery system can be arranged in cooperation with Mancipatio",
          ],
        },
      ],
    },
    flow: [
      FLOW_ONBOARD,
      FLOW_FORM_CONTACT,
      FLOW_REVIEW,
      FLOW_MINT,
      FLOW_TRADE,
      FLOW_DELIVERY,
    ],
  },
  {
    enumValue: AssetType.PhysicalGood,
    slug: "physical",
    code: "NON-FUNGIBLE",
    title: "Non-fungible assets",
    oneLine:
      "Unique assets — art, collectibles, used cars — where you care exactly which one you get.",
    encoded: ["Custodian", "Insurance policy", "Inspection cadence"],
    fact: "One-of-a-kind items — escrowed delivery on request",
    example: "Rare art piece in bonded warehouse",
    icon: <IconLock />,
    factSheet: {
      lead: "Tokenisation of unique assets — where you care exactly which item you get, from art pieces to used cars.",
      sections: [
        {
          heading: "What non-fungible means",
          points: [
            "Non-fungible assets cannot be substituted with like assets — when you buy a used car, you inspect that exact car, because every one is in a different state",
            "Most art is non-fungible: which exact painting you get matters, and even the same artist isn't enough",
            "NFTs are usually non-fungible — although, despite the name, some are actually fungible",
          ],
        },
        {
          heading: "What can be tokenized",
          points: [
            "Most asset types can be tokenized — from art pieces to used cars",
            "Tokenized assets are freely transferable and tradeable",
          ],
        },
        {
          heading: "Physical delivery",
          points: [
            "Deliverable assets can be redeemed through the platform: deposit the token into escrow, receive the item, and the token is burned on confirmed delivery",
            "If a delivery is cancelled, the token is returned to the holder",
            "Mancipatio doesn't handle the logistics itself, but the delivery system can be arranged in cooperation with Mancipatio",
          ],
        },
      ],
    },
    flow: [
      FLOW_ONBOARD,
      FLOW_FORM_CONTACT,
      FLOW_REVIEW,
      FLOW_MINT,
      FLOW_TRADE,
      FLOW_DELIVERY,
    ],
  },
  {
    enumValue: AssetType.Other,
    slug: "other",
    code: "OTHER",
    title: "Other",
    oneLine:
      "Bespoke claims that don't fit a standard category but follow the same program.",
    encoded: ["Custom metadata pointer", "Standard compliance hook"],
    fact: "Custom rights and structures with our legal team",
    example: "Carbon credits, IP licences, structured products",
    icon: <IconBox />,
    factSheet: {
      lead: "Tokenisation infrastructure for everything beyond the main use cases — rights, services, platform utility and more.",
      sections: [
        {
          heading: "What we offer",
          points: [
            "The platform's technology can be used in ways not covered by the main use cases",
            "The technology tokenises the asset; our legal team makes sure the token rights are binding on the issuer",
            "Bespoke technical and legal structuring, designed around your idea",
          ],
        },
        {
          heading: "How to start",
          points: [
            "Tell us about your idea — rights, services, platform utility, anything that needs tokenization infrastructure",
            "We evaluate the business idea and propose a solution",
            "If we agree, we create a dedicated process together",
          ],
        },
      ],
    },
    flow: [
      FLOW_ONBOARD,
      FLOW_FORM_CONTACT,
      FLOW_REVIEW,
      FLOW_MINT,
      FLOW_TRADE,
      "For anything bespoke, we design the rest of the process together — start by telling us your idea on the contact page.",
    ],
  },
];

export function assetTypeBySlug(slug: string): AssetTypeRecord | undefined {
  return ASSET_TYPES.find((r) => r.slug === slug);
}

export function slugForEnum(value: AssetType | undefined): string {
  if (value === undefined) return "";
  return ASSET_TYPES.find((r) => r.enumValue === value)?.slug ?? "";
}

export function enumForSlug(slug: string): AssetType | undefined {
  return ASSET_TYPES.find((r) => r.slug === slug)?.enumValue;
}

/** Category-specific create/manage field schema, keyed by slug. Each key maps to
 *  a column on `asset_profiles` (migration 0014). Common fields (display_name,
 *  summary, description, website, jurisdiction, legal doc) are handled by the
 *  wizard chrome, not listed here. */
export const CATEGORY_FIELDS: Record<CategorySlug, FieldDef[]> = {
  equity: [
    { key: "round_series", label: "Round / series", type: "text", placeholder: "Series A" },
    { key: "pre_money_valuation", label: "Pre-money valuation (USD)", type: "number" },
    { key: "share_price", label: "Share price (USD)", type: "number" },
    { key: "total_shares", label: "Total shares", type: "number" },
    { key: "has_voting", label: "Carries voting rights", type: "boolean" },
    { key: "dividend_policy", label: "Dividend policy", type: "text", placeholder: "e.g. discretionary, 20% of net profit" },
    { key: "liquidation_pref_bps", label: "Liquidation preference (×)", type: "mult", help: "e.g. 1 = 1× non-participating" },
    { key: "convertible", label: "Convertible into registered shares", type: "boolean" },
  ],
  debt: [
    { key: "principal", label: "Principal (USD)", type: "number" },
    { key: "coupon_rate_bps", label: "Coupon rate (%)", type: "bps" },
    { key: "coupon_frequency", label: "Coupon frequency", type: "select", options: ["Monthly", "Quarterly", "Semi-annual", "Annual", "At maturity"] },
    { key: "maturity_date", label: "Maturity date", type: "date" },
    { key: "seniority", label: "Seniority", type: "select", options: ["Senior secured", "Senior unsecured", "Subordinated", "Mezzanine"] },
    { key: "default_trigger", label: "Default trigger", type: "text", placeholder: "e.g. 30-day non-payment" },
    { key: "collateral_desc", label: "Collateral", type: "textarea" },
  ],
  real_estate: [
    { key: "spv_reference", label: "SPV reference", type: "text" },
    { key: "address", label: "Property address", type: "text" },
    { key: "square_meters", label: "Square meters", type: "number" },
    { key: "valuation", label: "Valuation (USD)", type: "number" },
    { key: "appraisal_date", label: "Appraisal date", type: "date" },
    { key: "income_share_bps", label: "Income / rent share (%)", type: "bps" },
    { key: "occupancy_pct", label: "Occupancy (%)", type: "number" },
    { key: "kyb_gated", label: "KYB-gated transfers", type: "boolean", default: true },
  ],
  royalty: [
    { key: "royalty_rate_bps", label: "Royalty rate (%)", type: "bps" },
    { key: "underlying_contract", label: "Underlying contract / IP reference", type: "text" },
    { key: "ip_description", label: "IP description", type: "textarea" },
    { key: "revenue_source", label: "Revenue source", type: "text", placeholder: "e.g. Spotify, publishing" },
    { key: "payment_frequency", label: "Payment frequency", type: "select", options: ["Monthly", "Quarterly", "Semi-annual", "Annual"] },
    { key: "termination_date", label: "Termination date", type: "date" },
    { key: "territory", label: "Territory", type: "text", placeholder: "Worldwide" },
    { key: "historical_revenue", label: "Historical revenue", type: "text" },
  ],
  revenue_share: [
    { key: "revenue_pct_bps", label: "Revenue share (%)", type: "bps" },
    { key: "revenue_basis", label: "Revenue basis", type: "select", options: ["gross", "net"] },
    { key: "cap_multiple", label: "Return cap (×)", type: "number", help: "e.g. 3 = 3× principal" },
    { key: "trigger_threshold", label: "Trigger threshold (USD)", type: "number" },
    { key: "measurement_period", label: "Measurement period", type: "text", placeholder: "e.g. calendar month" },
    { key: "reporting_cadence", label: "Reporting cadence", type: "select", options: ["Monthly", "Quarterly", "Semi-annual", "Annual"] },
  ],
  commodity: [
    { key: "underlying", label: "Underlying spec / grade", type: "text", placeholder: "e.g. LBMA-grade gold" },
    { key: "unit", label: "Unit", type: "text", placeholder: "kg, oz, barrel" },
    { key: "quantity", label: "Quantity", type: "number" },
    { key: "storage_provider", label: "Storage provider", type: "text" },
    { key: "storage_location", label: "Storage location", type: "text", placeholder: "e.g. Zurich vault" },
    { key: "storage_proof_ref", label: "Storage proof reference", type: "text" },
    { key: "settlement_window", label: "Settlement window", type: "text", placeholder: "e.g. T+2" },
  ],
  physical: [
    { key: "item_description", label: "Item description", type: "textarea" },
    { key: "custodian", label: "Custodian", type: "text" },
    { key: "custody_location", label: "Custody location", type: "text", placeholder: "e.g. bonded warehouse" },
    { key: "insurance_policy_ref", label: "Insurance policy reference", type: "text" },
    { key: "insurance_coverage", label: "Insurance coverage", type: "text", placeholder: "e.g. $2M all-risk" },
    { key: "appraised_value", label: "Appraised value (USD)", type: "number" },
    { key: "inspection_cadence", label: "Inspection cadence", type: "select", options: ["Monthly", "Quarterly", "Semi-annual", "Annual"] },
  ],
  other: [
    { key: "schema_label", label: "Schema label", type: "text", placeholder: "e.g. carbon-credit-v1" },
    { key: "custom_metadata_uri", label: "Custom metadata URI", type: "text", placeholder: "https:// or ipfs://" },
  ],
};

export function fieldsForCategory(slug: string): FieldDef[] {
  return (CATEGORY_FIELDS as Record<string, FieldDef[]>)[slug] ?? [];
}

/** The seven on-chain ShareClassType enum values (mirrors
 *  `ShareClassType` in lib/generated/asset_registry, same index order). The
 *  index IS the enum value, so these labels are passed straight to a `<select>`
 *  with `value={index}`. */
export const SHARE_CLASS_TYPE_LABELS = [
  "Common",
  "Preferred A",
  "Preferred B",
  "Senior debt",
  "Junior debt",
  "Rev-share tier",
  "Royalty tier",
] as const;

/** Which ShareClassType enum values make sense for a given AssetType. The
 *  numbers are the `ShareClassType` enum indices. Used to constrain the class
 *  type `<select>` in the share-class create flows so issuers can't, say,
 *  attach a "Royalty tier" to an equity asset. Anything not listed (or an
 *  unknown asset type) falls back to Common only. */
const SHARE_CLASS_TYPES_BY_ENUM: Record<number, number[]> = {
  [AssetType.Equity]: [0, 1, 2], // Common, Preferred A, Preferred B
  [AssetType.Debt]: [3, 4], // Senior debt, Junior debt
  [AssetType.RevenueShare]: [5], // Rev-share tier
  [AssetType.Royalty]: [6], // Royalty tier
  [AssetType.RealEstate]: [0, 1, 2], // fractional ownership behaves like equity
  [AssetType.Commodity]: [0], // Common
  [AssetType.PhysicalGood]: [0], // Common
  [AssetType.Other]: [0, 1, 2, 3, 4, 5, 6], // bespoke — allow everything
};

/** Return the allowed ShareClassType enum values for a given AssetType enum,
 *  as `{ value, label }` pairs ready to feed a `<select>`. Falls back to
 *  Common only when the asset type is undefined or unmapped. */
export function shareClassTypesForAssetType(
  assetType: AssetType | undefined,
): { value: number; label: string }[] {
  const allowed =
    assetType !== undefined && SHARE_CLASS_TYPES_BY_ENUM[assetType]
      ? SHARE_CLASS_TYPES_BY_ENUM[assetType]
      : [0];
  return allowed.map((v) => ({ value: v, label: SHARE_CLASS_TYPE_LABELS[v] }));
}
