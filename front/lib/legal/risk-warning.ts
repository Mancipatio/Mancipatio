// The risk warning a buyer reads and confirms before a purchase: the
// launchpad sale page and the OTC take-offer confirmation
// (/marketplace/otc/[offer]) carry its checkbox; the OTC deal deposit
// (/portfolio/deals) shows it above the Deposit button. It warns of the risk
// of partial or total loss and that digital asset transactions are not
// covered by deposit insurance or investor protection. (The first version was
// written against ZDI art. 15(2), for a Serbian operator; the mainnet
// operator is a BVI company, lib/legal/operator.ts.)
//
// ONE constant, rendered by components/legal/purchase-risk-warning.tsx on
// every network. The wording below is counsel's: the owner stated on
// 2026-10-02 that counsel approved the package of drafts of 2026-09-30, whose
// risk warning (the mainnet kit's 05-mainnet-copy.draft.ts, outside the
// repository) is transferred here verbatim, hence `status: "counsel"`. A
// mainnet build refuses a warning whose status is "draft"
// (lib/legal/readiness.ts). Its points about the sale's escrow and the
// proceeds freeze speak of a primary sale only: before
// NEXT_PUBLIC_FEATURE_SECONDARY_TRADING is switched on for mainnet, counsel
// decides whether OTC trades need points of their own.
//
// Directive-free and import-free.

export type RiskWarning = {
  /** "draft" until counsel approves the wording, then "counsel". */
  status: "draft" | "counsel";
  title: string;
  points: string[];
  /** The checkbox label the buyer confirms. */
  acknowledgement: string;
};

/** Also shown on /risks. */
export const NO_INVESTOR_PROTECTION =
  "Digital asset transactions are not covered by deposit insurance or by any investor protection or compensation scheme.";

export const PURCHASE_RISK_WARNING: RiskWarning = {
  status: "counsel",
  title: "Risk warning",
  points: [
    "You can lose part or all of the money you commit.",
    NO_INVESTOR_PROTECTION,
    "This is a closed pilot that runs before any independent external audit of the on-chain programs. A defect in the programs, the site or the Solana network can cause a loss that no one can reverse.",
    "A purchase in a primary sale is final once it is confirmed on-chain: the price goes into the sale's escrow and is paid to the issuer when the sale closes, and for the sales offered in the pilot no instruction refunds it to you.",
    "In a primary sale, if the issuer's proceeds are frozen, money already paid into its sale stays locked in the sale's escrow for as long as the freeze lasts: it is neither paid to the issuer nor refunded to you.",
    "There is no exchange listing and no guaranteed buyer: you may not be able to sell when you want to, or at all.",
    "Your tokens can be moved without your signature into a burn-only quarantine, from which they are never returned, if your wallet is placed on the sanctions blocklist or, on a KYC-gated class, if your verification is revoked or has been expired for at least 30 days.",
    "In an emergency the platform can pause sales and trading through Manci; refunds, claims and other exits keep working.",
    "What your tokens are worth depends on the issuer: distributions, conversion and redemption need the issuer to perform, and a claim against the issuer is not a payment.",
    "Converting tokens into company shares or redeeming a physical asset requires identity verification.",
  ],
  acknowledgement:
    "I have read this risk warning and understand that I can lose all of the money I commit.",
};
