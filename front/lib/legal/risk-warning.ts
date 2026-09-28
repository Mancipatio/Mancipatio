// The risk warning a buyer reads and confirms before a purchase: the
// launchpad sale page and the OTC take-offer confirmation
// (/marketplace/otc/[offer]) carry its checkbox; the OTC deal deposit
// (/portfolio/deals) shows it above the Deposit button. ZDI art. 15(2):
// before the relationship is established the user must be warned of the risk
// of partial or total loss and that digital asset transactions are not
// covered by deposit insurance or investor protection.
//
// ONE constant, rendered by components/legal/purchase-risk-warning.tsx. The
// wording below is engineering's draft of facts the site already states (/risks,
// /security); counsel replaces it and sets `status: "counsel"`. A mainnet
// build refuses the draft (lib/legal/readiness.ts).
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
    "There is no exchange listing and no guaranteed buyer: you may not be able to sell when you want to, or at all.",
    "Your tokens can be moved without your signature into a burn-only quarantine if your wallet is placed on the sanctions blocklist, or, on a KYC-gated class, if your verification is revoked or expires.",
    "In an emergency the platform can pause sales and trading through Manci; refunds, claims and other exits keep working.",
    "Converting tokens into company shares or redeeming a physical asset requires identity verification.",
  ],
  acknowledgement:
    "I have read this risk warning and understand that I can lose all of the money I commit.",
};
