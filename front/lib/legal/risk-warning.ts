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
// every network. Counsel approved the first wording (the owner's statement of
// 2026-10-02: the package of drafts of 2026-09-30, the mainnet kit's
// 05-mainnet-copy.draft.ts, outside the repository). Points 3, 4, 7 and 10
// were changed with the Terms of 2026-10-03 (lib/legal/mainnet-copy.ts, the
// owner's decisions D1-D7, whose model counsel approved); that wording is a
// draft until counsel confirms it, hence `status: "draft"`: a mainnet build
// refuses it (lib/legal/readiness.ts), and with it the Terms of 2026-10-03,
// so release/mainnet cannot carry them before then. Set it back to
// "counsel" in the commit that records counsel's confirmation (the header of
// lib/legal/mainnet-copy.ts lists what else changes with it). The status is
// read only by that mainnet build guard: devnet renders the same points.
// Its points about the sale's escrow and the proceeds freeze speak of a
// primary sale only: before
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
  status: "draft",
  title: "Risk warning",
  points: [
    "You can lose part or all of the money you commit.",
    NO_INVESTOR_PROTECTION,
    "The on-chain programs have had internal security reviews only; no independent external audit has been completed. A defect in the programs, the site or the Solana network can cause a loss that no one can reverse.",
    "A purchase in a primary sale is final once it is confirmed on-chain: the price goes into the sale's escrow and is paid to the issuer when the sale closes, and for the sales currently offered no instruction refunds it to you.",
    "In a primary sale, if the issuer's proceeds are frozen, money already paid into its sale stays locked in the sale's escrow for as long as the freeze lasts: it is neither paid to the issuer nor refunded to you.",
    "There is no exchange listing and no guaranteed buyer: you may not be able to sell when you want to, or at all.",
    "Your tokens can be moved without your signature into a burn-only quarantine, from which they are never returned, if your wallet is placed on the blocklist (for example after a sanctions match or a purchase in a primary sale made other than through the Manci site) or, on a KYC-gated class, if your verification is revoked or has been expired for at least 30 days.",
    "In an emergency the platform can pause sales and trading through Manci; refunds, claims and other exits keep working.",
    "What your tokens are worth depends on the issuer: distributions, conversion and redemption need the issuer to perform, and a claim against the issuer is not a payment.",
    "Converting tokens into company shares, where conversion is available and the issuer offers it, or redeeming a physical asset requires identity verification; buying and holding tokens of an open class do not.",
  ],
  acknowledgement:
    "I have read this risk warning and understand that I can lose all of the money I commit.",
};
