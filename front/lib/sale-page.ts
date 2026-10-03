// The launchpad sale page (app/marketplace/launchpad/[sale]/page.tsx): what
// it calls the sale and its button, the token summary of a tokenized share
// class, and the acceptance the Buy button waits for.
//
// Layout (owner feedback 2026-10-03): the buy card comes first — a sticky
// right column on a wide screen, right under the company header on a phone —
// and the full investment document block and risk warning sit beside it, as
// the first section of the Overview. The two acceptance checkboxes stay in
// the buy card, directly above the button, each with a link to the full text
// (components/launchpad/sale-sections).
//
// A tokenized share class is a Mature sale of an asset made by the tokenize
// flow (its public profile carries one token's share of the company,
// lib/profile-public token_percent_e4): it sells TOKENS, each a fixed share
// of the company, so the page says "Buy tokens" and "Sold", never "shares"
// or "payment token units".
//
// Pure and node-safe: tests/sale-page-layout.test.ts.
import { progressPct } from "@/lib/launch-math";
import { formatPercent, formatTokens, HUNDRED_PERCENT_E4, OPEN_TOKENS_NOTE } from "@/lib/tokenize-shares";

/** The main column's full texts; the buy card's "read" links lead here. */
export const SALE_DOCUMENTS_ANCHOR = "investment-documents";
export const SALE_RISK_WARNING_ANCHOR = "risk-warning";

/** What the page sells: tokens of a tokenized share class, other on-chain shares, or a Startup raise (soft commitments). */
export type SaleKind = "tokenized" | "mature" | "startup";

export function saleKind(input: { settlesOnChain: boolean; tokenPercentE4: bigint | null }): SaleKind {
  if (!input.settlesOnChain) return "startup";
  return input.tokenPercentE4 !== null && input.tokenPercentE4 > BigInt(0) ? "tokenized" : "mature";
}

/** The buy card's title. */
export function buyCardTitle(kind: SaleKind): string {
  return kind === "tokenized" ? "Buy tokens" : kind === "mature" ? "Buy shares" : "Back this company";
}

/**
 * The company of a tokenized class's listing name: the tokenize flow names
 * the token "<company> · <stake> %" (lib/tokenize-shares displayNameFor), so
 * "0.1 % of HERC", never "0.1 % of HERC · 10 %". Any other name is kept.
 */
export function companyOfTokenizedName(name: string): string {
  const m = /^(.+?) · \d+(?:\.\d+)? %$/.exec(name.trim());
  return m ? m[1] : name;
}

/** The progress label of an on-chain sale (tokens sold of the tokens for sale). */
export const SOLD_LABEL = "Sold";

/**
 * The buy card's footnote terms, only those the application states:
 * "Min ticket: $1,000 · Structure: SAFE", or null when neither is known (a
 * tokenized sale has no application, so it never shows "Min ticket: — ·
 * Structure: —").
 */
export function saleTermsFootnote(input: { minTicket: string | null | undefined; structure: string | null | undefined }): string | null {
  const parts = [
    input.minTicket?.trim() ? `Min ticket: ${input.minTicket.trim()}` : null,
    input.structure?.trim() ? `Structure: ${input.structure.trim()}` : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Whether the buyer accepted what a purchase needs: the investment document
 * version served for THIS sale and the risk warning. The page's Buy button
 * and both send paths require it; the server checks the accepted version
 * again (#58 Terms) and screens the wallet before the wallet opens.
 */
export function purchaseAcceptanceComplete(input: {
  salePubkey: string;
  /** The sale the served document terms belong to (null until they load). */
  documentSale: string | null | undefined;
  acceptedTerms: boolean;
  acceptedRisk: boolean;
}): boolean {
  return input.documentSale === input.salePubkey && input.acceptedTerms && input.acceptedRisk;
}

/** Restriction mode of the class as the page read it (null: not read yet). */
export type ClassRestriction = "open" | "kyc-gated" | null;

/** What a KYC-gated tokenized class says instead of "anyone can hold". */
export const KYC_GATED_TOKENS_NOTE =
  "This class is KYC-gated: buying and holding it needs an approved investor passport for your wallet.";

/**
 * The token summary of a tokenized share class, as lines: the profile's own
 * summary when it has one (the tokenize flow writes "N tokens = P % of
 * <company>. Anyone can hold and transfer them. KYC is needed only to convert
 * them into company shares."), else the same sentence from the class cap
 * (the flow caps class 0 at exactly the tokenized tokens); then one token's
 * share; and, for a class made KYC-gated, that holding needs a passport.
 * Empty without the tokenize figures.
 */
export function tokenSummaryLines(input: {
  company: string;
  /** The public profile's summary (null/blank: none). */
  profileSummary: string | null | undefined;
  /** The class's max supply (null: uncapped or unknown). */
  capTokens: bigint | null;
  /** One token's share of the company in 1/10,000 % (lib/profile-public token_percent_e4). */
  tokenPercentE4: bigint | null;
  restriction: ClassRestriction;
}): string[] {
  const e4 = input.tokenPercentE4;
  if (e4 === null || e4 <= BigInt(0) || e4 > HUNDRED_PERCENT_E4) return [];
  const lines: string[] = [];
  const own = input.profileSummary?.trim();
  if (own) {
    lines.push(own);
  } else if (input.capTokens !== null && input.capTokens > BigInt(0) && input.capTokens * e4 <= HUNDRED_PERCENT_E4) {
    const stake = `${formatTokens(input.capTokens)} tokens = ${formatPercent(input.capTokens * e4)} % of ${input.company}.`;
    lines.push(input.restriction === "open" ? `${stake} ${OPEN_TOKENS_NOTE}` : stake);
  }
  lines.push(`1 token = ${formatPercent(e4)} % of ${input.company}.`);
  if (input.restriction === "kyc-gated") lines.push(KYC_GATED_TOKENS_NOTE);
  return lines;
}

/** Tokens sold of the tokens for sale, as the compact progress shows them. */
export function soldProgress(sold: bigint, total: bigint): { sold: string; total: string; percent: number } {
  return { sold: formatTokens(sold), total: formatTokens(total), percent: progressPct(Number(sold), Number(total)) };
}
