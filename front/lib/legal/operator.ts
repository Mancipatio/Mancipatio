// The platform operator: the legal entity that runs Manci on a network, its
// licence, its contacts and the law that governs its terms. ONE record per
// network, and every page that names the operator reads it from here: the
// app footer (components/app-shell.tsx), the Terms (operator clause), the
// Privacy Policy (controller), /about, /contact, /security and /legal/company.
//
// Why a committed file rather than NEXT_PUBLIC_* variables: these details are
// public by nature (they are in the business register and on the licence),
// a change is reviewed as a diff, and the tests and the mainnet build guard
// (next.config.ts → lib/legal/readiness.ts) check exactly the values the
// pages render. Filling in the company is one edit to OPERATORS.mainnet, not a
// dozen Vercel variables where a typo ships unnoticed. Nothing here is secret.
//
// When the company and the licence arrive: fill in OPERATORS.mainnet below
// and run `npx vitest run tests/legal-slots.test.ts --silent=false` — its
// "mainnet legal slots" report lists every field a mainnet build still refuses.
//
// Directive-free and import-free apart from a type (next.config.ts loads it).

import type { Network } from "../network";

/** A licence the operator holds for the services offered on the site. */
export type OperatorLicence = {
  /** Issuing authority, e.g. "Securities Commission of the Republic of Serbia". */
  authority: string;
  /** The decision (rešenje) number, as written on the decision. */
  decisionNumber: string;
  /** Date of the decision, yyyy-mm-dd. */
  decisionDate: string;
  /** The services the licence covers, worded as in the decision. */
  services: string[];
  /** The regulator's public register entry for the operator, if there is one. */
  registerUrl: string | null;
};

export type OperatorContacts = {
  /** User support. Optional: null means the contact form (/contact) is the
   *  support channel, which the site links from every page. */
  support: string | null;
  /** Legal notices and questions about the Terms. */
  legal: string | null;
  /** Personal-data requests (the controller's contact). */
  privacy: string | null;
  /** Vulnerability reports. Must match the programs' embedded security.txt
   *  and public/.well-known/security.txt. */
  security: string | null;
  /** Data protection officer, when one is appointed (not always required). */
  dpo: string | null;
};

export type Operator = {
  /** The trading name used across the site. */
  brand: string;
  /** Full registered name, e.g. "Manci d.o.o. Beograd". */
  legalName: string | null;
  /** Short registered name, e.g. "Manci d.o.o.". */
  shortName: string | null;
  /** Registered office (sedište), one line: street and number, postcode, city, country. */
  registeredOffice: string | null;
  /** Company registration number (matični broj, MB). */
  registrationNumber: string | null;
  /** Tax identification number (PIB). */
  taxId: string | null;
  /** The register the company is entered in, e.g. the Serbian Business
   *  Registers Agency (APR), with a link to the entry when there is one. */
  register: { name: string; url: string | null } | null;
  /** null when no licence is held. A mainnet build then also needs
   *  MAINNET_LICENSE_NOT_REQUIRED=true (lib/legal/readiness.ts). */
  licence: OperatorLicence | null;
  contacts: OperatorContacts;
  /** Governing law of the Terms, e.g. "the law of the Republic of Serbia". Counsel decides. */
  governingLaw: string | null;
  /** Court or arbitration for disputes, e.g. "the competent court in Belgrade". Counsel decides. */
  disputeResolution: string | null;
  /** Shown instead of the company details while no legal entity operates
   *  this deployment (the devnet pilot). Must be null on mainnet. */
  pilotNotice: string | null;
};

/** The addresses the site and the programs' security.txt already publish.
 *  No support address is published today: support is the contact form. */
const CURRENT_CONTACTS: OperatorContacts = {
  support: null,
  legal: "legal@mancipatio.io",
  privacy: "privacy@mancipatio.io",
  security: "security@mancipatio.io",
  dpo: null,
};

export const OPERATORS: Readonly<{ devnet: Operator; mainnet: Operator }> = {
  // Devnet, testnet and localnet: the pilot as it stands today.
  devnet: {
    brand: "Manci",
    legalName: null,
    shortName: null,
    registeredOffice: null,
    registrationNumber: null,
    taxId: null,
    register: null,
    licence: null,
    contacts: CURRENT_CONTACTS,
    governingLaw: null,
    disputeResolution: null,
    pilotNotice:
      "The devnet pilot is not yet operated by a designated legal entity and holds no licence. Tokens on devnet have no economic value. The operator's name, registration details and licence will be published here before the mainnet launch.",
  },
  // Mainnet: filled in when the company is registered and the licence is
  // granted. Until every required field is set a mainnet build is refused.
  mainnet: {
    brand: "Manci",
    legalName: null,
    shortName: null,
    registeredOffice: null,
    registrationNumber: null,
    taxId: null,
    // e.g. { name: "Serbian Business Registers Agency (APR)", url: "<the company's APR entry>" }
    register: null,
    // e.g. { authority: "Securities Commission of the Republic of Serbia",
    //        decisionNumber: "…", decisionDate: "yyyy-mm-dd",
    //        services: ["…as worded in the decision…"], registerUrl: null }
    licence: null,
    // Confirm these before launch: they are the addresses published today.
    // Set `support` if the company has a support mailbox (null keeps the
    // contact form as the support channel).
    contacts: CURRENT_CONTACTS,
    governingLaw: null,
    disputeResolution: null,
    pilotNotice: null,
  },
};

/** The operator record of `network` (test networks share the devnet record). */
export function operatorFor(network: Network): Operator {
  return network === "mainnet" ? OPERATORS.mainnet : OPERATORS.devnet;
}

/** True when a legal entity is named (the company details can be shown). */
export function hasOperatorEntity(operator: Operator): boolean {
  return Boolean(operator.legalName?.trim());
}

/** "Securities Commission of the Republic of Serbia, decision 1/2026 of 2026-10-01". */
export function licenceLine(licence: OperatorLicence): string {
  return `${licence.authority}, decision ${licence.decisionNumber} of ${licence.decisionDate}`;
}

/** The copyright holder: the registered name, or the brand without an entity. */
export function copyrightHolder(operator: Operator): string {
  return hasOperatorEntity(operator) ? operator.legalName!.trim() : operator.brand;
}

/** "<office> · MB … · PIB …" when a legal entity is named; null otherwise. */
export function operatorRegistrationLine(operator: Operator): string | null {
  if (!hasOperatorEntity(operator)) return null;
  const parts = [
    operator.registeredOffice,
    operator.registrationNumber ? `MB ${operator.registrationNumber}` : null,
    operator.taxId ? `PIB ${operator.taxId}` : null,
  ].filter((part): part is string => Boolean(part?.trim()));
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The footer's operator line: "© <year> <registered name> · <office> · MB …
 * · PIB … · Licence: <authority>, decision … of …". null while no legal
 * entity operates the network (the devnet pilot): the footer then shows only
 * its link to /legal/company, which carries the pilot notice.
 */
export function operatorFooterLine(operator: Operator, year: number): string | null {
  if (!hasOperatorEntity(operator)) return null;
  const parts = [`© ${year} ${copyrightHolder(operator)}`];
  const registration = operatorRegistrationLine(operator);
  if (registration) parts.push(registration);
  if (operator.licence) parts.push(`Licence: ${licenceLine(operator.licence)}`);
  return parts.join(" · ");
}

/**
 * One paragraph naming the operator on a legal page: "Manci is operated by
 * <legal name>, registered office …, registration number (MB) …, tax ID (PIB)
 * …. Licence: …." Without an entity it is the pilot notice (devnet).
 */
export function operatorSentence(operator: Operator): string | null {
  if (!hasOperatorEntity(operator)) return operator.pilotNotice;
  const parts = [`${operator.brand} is operated by ${operator.legalName?.trim()}`];
  if (operator.registeredOffice) parts.push(`registered office ${operator.registeredOffice}`);
  if (operator.registrationNumber) parts.push(`registration number (MB) ${operator.registrationNumber}`);
  if (operator.taxId) parts.push(`tax ID (PIB) ${operator.taxId}`);
  const licence = operator.licence ? ` Licence: ${licenceLine(operator.licence)}.` : "";
  return `${parts.join(", ")}.${licence}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DRAFT_MARKER_RE = /\b(TODO|TBD|XXX)\b|placeholder|to be confirmed|lorem ipsum/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function missing(value: string | null | undefined): boolean {
  return !value || !value.trim() || DRAFT_MARKER_RE.test(value);
}

/**
 * What a mainnet build refuses in `operator`, one sentence per field; empty
 * when the record is complete. The licence is optional here — whether it may
 * be absent is decided in lib/legal/readiness.ts.
 */
export function operatorProblems(operator: Operator): string[] {
  const problems: string[] = [];
  const required: Array<[string, string | null]> = [
    ["legalName (full registered name)", operator.legalName],
    ["shortName (short registered name)", operator.shortName],
    ["registeredOffice (sedište)", operator.registeredOffice],
    ["registrationNumber (MB)", operator.registrationNumber],
    ["taxId (PIB)", operator.taxId],
    ["register.name (e.g. APR)", operator.register?.name ?? null],
    ["governingLaw", operator.governingLaw],
    ["disputeResolution (court or arbitration)", operator.disputeResolution],
  ];
  for (const [field, value] of required) {
    if (missing(value)) problems.push(`operator.${field} is not set`);
  }
  for (const key of ["legal", "privacy", "security"] as const) {
    const email = operator.contacts[key];
    if (missing(email) || !EMAIL_RE.test(email!.trim())) {
      problems.push(`operator.contacts.${key} must be an email address`);
    }
  }
  // Optional contacts: null is allowed (support → the contact form; a DPO is
  // not always required), anything set must be an address.
  for (const key of ["support", "dpo"] as const) {
    const email = operator.contacts[key];
    if (email !== null && !EMAIL_RE.test(email.trim())) {
      problems.push(`operator.contacts.${key} must be an email address or null`);
    }
  }
  if (operator.pilotNotice !== null) {
    problems.push("operator.pilotNotice must be null on mainnet");
  }
  const licence = operator.licence;
  if (licence) {
    if (missing(licence.authority)) problems.push("operator.licence.authority is not set");
    if (missing(licence.decisionNumber)) problems.push("operator.licence.decisionNumber is not set");
    if (!ISO_DATE_RE.test(licence.decisionDate) || !Number.isFinite(Date.parse(licence.decisionDate))) {
      problems.push("operator.licence.decisionDate must be a yyyy-mm-dd date");
    }
    if (licence.services.length === 0 || licence.services.some((s) => missing(s))) {
      problems.push("operator.licence.services must list the licensed services");
    }
  }
  return problems;
}
