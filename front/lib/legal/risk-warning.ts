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
// owner's decisions D1-D7, whose model counsel approved). Counsel confirmed
// that exact wording as well (the owner's statement of 2026-10-03, recorded
// in PR #57), and version 2026-10-03 is the one release/mainnet carries.
//
// Version 2026-10-10 (THIS TEXT, HELD): with the Terms that offer trading
// through Manci and conversion (lib/legal/mainnet-copy.ts), point 10 no
// longer says "where conversion is available", and points 11-13 cover trades
// through Manci (an offer taken, an OTC deal deposit), which the OTC
// take-offer confirmation and the deal deposit show. Points 4 and 5 still
// speak of a primary sale only. Counsel has not confirmed this wording yet,
// so the status is "draft": a mainnet build refuses a draft
// (lib/legal/readiness.ts), and with it the Terms it belongs to (the header
// of lib/legal/mainnet-copy.ts lists what changes with a new version). The
// commit that records counsel's confirmation sets it back to "counsel". The
// status is read only by that mainnet build guard: devnet renders the same
// points.
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
    "Converting tokens into company shares, where the issuer offers it, or redeeming a physical asset requires identity verification; buying, holding and trading tokens of an open class do not.",
    "In a trade through Manci (an offer or an OTC deal), Manci is not a party: it sets no price, shows no reference price and does not verify who your counterparty is. You pay in USDC, and a settled trade is final.",
    "When you take an offer, the price goes to the seller and the units come to you in the same transaction; it cannot be reversed or refunded.",
    "In an OTC deal, your deposit stays in the deal's escrow until the other side deposits. If an administrator cancels the deal or it expires first, your deposit is refunded to you; once both sides have deposited, the deal settles and is final.",
  ],
  acknowledgement:
    "I have read this risk warning and understand that I can lose all of the money I commit.",
};
