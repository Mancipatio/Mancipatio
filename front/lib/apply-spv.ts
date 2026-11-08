// The /apply branch for companies outside Serbia (app/(marketing)/apply):
// company ownership, debt and revenue share are issued through a Serbian
// company, so an applicant whose company is incorporated anywhere else, or
// not yet, sees the Serbian SPV panel and may ask Manci to incorporate one.
//
// The choice is stored in launch_applications.company_formation_requested
// (0056; no new column): the submit and resubmit routes read it as the
// top-level signed param `company_formation_requested` and force it to true
// for an individual applicant (verified KYC, no company yet). This module is
// the client half: when the panel shows, and what the form sends. The admin
// queue shows the stored choice as "SPV requested" (app/admin/applications).
//
// The SPV copy shared by the panel and the public guide
// (/solutions/serbian-spv) lives here so the two say the same thing; it is
// listed in the PR under "Copy for counsel review".
//
// Pure and node-safe: tests/apply-spv.test.ts.

/** The incorporation answer that needs no SPV (the first option of the /apply list). */
export const SERBIA_INCORPORATION = "Serbia";

/** The public guide the panel and the issuer journey link to. */
export const SERBIAN_SPV_GUIDE = "/solutions/serbian-spv";

/** The checkbox label: the applicant's explicit choice. */
export const SPV_CHOICE_LABEL = "I want Manci to incorporate a Serbian SPV for this issuance.";

/** True when the applicant needs a Serbian company to issue through: an individual, or a company not incorporated in Serbia. */
export function spvPathApplies(input: { isIndividual: boolean; incorporation: string | null }): boolean {
  return input.isIndividual || (input.incorporation ?? "").trim() !== SERBIA_INCORPORATION;
}

/**
 * What the form sends as `company_formation_requested`: always for an
 * individual (the server forces it too), otherwise the ticked choice, and
 * only while the panel applies — a company that switches its answer back to
 * Serbia does not keep a stale request.
 */
export function formationRequested(input: { isIndividual: boolean; incorporation: string | null; spvChosen: boolean }): boolean {
  if (input.isIndividual) return true;
  return spvPathApplies(input) && input.spvChosen;
}

/** What the applicant will need to provide (the engagement confirms the exact list). */
export const SPV_REQUIREMENTS: readonly string[] = [
  "Identity verification on Manci: KYC for an individual applicant, or KYB for an existing company.",
  "Your company's registry extract and its founding act or articles of association.",
  "Who owns and controls the company: shareholders, beneficial owners and directors, with identification of the people who sign.",
  "The decision of your company's competent body approving the issuance and its structure.",
  "The issuance terms: what the tokens represent (company ownership, debt or revenue share), the amount and the price.",
  "Certified translations or apostilles, where the Serbian business register requires them.",
];

/** Costs, as the pricing page states them: third-party, quoted before any work starts. */
export const SPV_COSTS =
  "Incorporation, notary, registry, translation and legal drafting are third-party costs. They are quoted per engagement before any work starts, and nothing is charged on-chain.";
