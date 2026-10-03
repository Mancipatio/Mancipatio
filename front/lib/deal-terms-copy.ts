// What the "Deal terms" tab of a launchpad sale (app/marketplace/launchpad/
// [sale]/page.tsx, TermsTab) tells the buyer they receive. Kept here, pure,
// so tests/legal-slots.test.ts can hold it to the mainnet Terms
// (lib/legal/mainnet-copy.ts): a Mature sale mints share-class tokens, which
// are bearer instruments (clause 5); conversion into company shares exists
// only where the issuer offers it, after identity verification, and only once
// its module is switched on (clauses 2, 6 and 12); the issuer limit is
// EUR 3,000,000 over any twelve months (clause 7, lib/raise-cap.ts).
//
// A Startup raise is a soft commitment settled off-chain under a SAFE-style
// agreement (switched off on mainnet: features().startupRaises), so its text
// keeps the equity wording.

import type { Network } from "@/lib/network";
import { MAINNET_RAISE_CAP_EUR } from "@/lib/raise-cap";

const CAP = `EUR ${MAINNET_RAISE_CAP_EUR.toLocaleString("en-US")}`;

/** The note under the "Raise amount" row. */
export const RAISE_LIMIT_NOTE = `Issuer limit: ${CAP} over any 12 months`;

/** The note under the "Equity offered" row. */
export function equityOfferedNote(isStartup: boolean): string {
  return isStartup ? "Actual company ownership" : "As set out in the offering document";
}

/** The "What you're buying" box: a lead and the sentences that follow it. */
export function whatYouAreBuying(input: {
  isStartup: boolean;
  /** The application's raise structure (e.g. "SAFE"), Startup raises only. */
  structure: string | null | undefined;
  /** moduleEnabled("custodyConversion", network). */
  conversionAvailable: boolean;
  network: Network;
}): { lead: string; body: string } {
  if (input.isStartup) {
    return {
      lead: "Real equity in a real company, not a token.",
      body:
        `You will receive a ${input.structure || "SAFE"} agreement granting you pro-rata ownership. ` +
        `Founders can sell up to ${CAP} of company equity through this platform over any 12 months.`,
    };
  }
  const conversion = input.conversionAvailable
    ? "Conversion into company shares is possible only where the issuer offers it, and requires identity verification (KYC)."
    : `Conversion into company shares is not available on Solana ${input.network} yet; once it is, it will be possible only where the issuer offers it, and will require identity verification (KYC).`;
  return {
    lead: "Share-class tokens, held in your own wallet.",
    body:
      "They are minted to your wallet when your purchase is confirmed. They are bearer instruments: whoever controls the wallet can transfer them. " +
      "Your rights against the issuer are those set out in the sale's offering document. " +
      `${conversion} ` +
      `Each issuer can raise at most ${CAP} through Manci over any 12 months.`,
  };
}
