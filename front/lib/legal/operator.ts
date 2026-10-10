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
// The record is jurisdiction-neutral: every number carries the name its
// jurisdiction gives it (a Serbian company's "MB" and "PIB", a BVI company's
// "BVI company number"), and the pages render those names from the record,
// never from code. A detail the operator's documents show is not assigned
// (e.g. a short name, where the register records a single name) is stated on
// purpose as { notAssigned: "<reason>" }; a plain null still means "not
// filled in" (or not yet confirmed) and a mainnet build refuses it, so a
// forgotten or unconfirmed field cannot pass.
//
// When a detail changes: edit OPERATORS.mainnet below and run
// `npx vitest run tests/legal-slots.test.ts --silent=false` — its "mainnet
// legal slots" report lists every field a mainnet build still refuses.
//
// Directive-free; imports only a type and ./document, which is import-free
// (next.config.ts loads this file).

import type { Network } from "../network";
import { isIsoDate } from "./document";

/** A licence the operator holds for the services offered on the site. */
export type OperatorLicence = {
  /** Issuing authority, e.g. "Securities Commission of the Republic of Serbia". */
  authority: string;
  /** The decision number, as written on the decision. */
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

/**
 * A number the operator is registered under, with the name its jurisdiction
 * gives it. The pages render the names, so a record from any jurisdiction
 * reads right: Serbia { value: "21000000", label: "registration number (MB)",
 * shortLabel: "MB" }, the BVI { value: "2219023", label: "BVI company number",
 * shortLabel: "BVI company number" }.
 */
export type RegisteredNumber = {
  /** The number as issued. */
  value: string;
  /** Its name in a sentence (Terms, Privacy Policy, /contact); with the first
   *  letter capitalised it is also the /legal/company row label. */
  label: string;
  /** Its name in the footer line, before the number ("MB 21000000"). */
  shortLabel: string;
};

/**
 * A detail the operator's jurisdiction does not assign, stated on purpose.
 * The string is the reason: kept in the record for review, never rendered.
 * A plain null means "not filled in yet", and a mainnet build refuses it.
 */
export type NotAssigned = { notAssigned: string };

/** The operator's registered agent, where the company has one (Manci
 *  International Ltd.'s Memorandum §4 names it, and §3 puts the registered
 *  office at the agent's office). */
export type RegisteredAgent = {
  name: string;
  /** One line, as written in the memorandum. */
  address: string;
};

export type Operator = {
  /** The trading name used across the site. */
  brand: string;
  /** Full registered name, e.g. "Manci d.o.o. Beograd", "Manci International Ltd.". */
  legalName: string | null;
  /** Short registered name, e.g. "Manci d.o.o.". Where the company's
   *  documents give a single registered name, { notAssigned }: the full name
   *  then stands alone. */
  shortName: string | NotAssigned | null;
  /** Registered office, one line (street and number or PO box, postcode,
   *  city, country), as the register records it. */
  registeredOffice: string | null;
  /** The company registration number, under its name in the jurisdiction. */
  registrationNumber: RegisteredNumber | null;
  /** The tax identification number under its name, or { notAssigned } where
   *  the owner has confirmed that none is assigned to the company (null until
   *  then; Manci International Ltd.: { notAssigned }, confirmed 2026-10-02). */
  taxId: RegisteredNumber | NotAssigned | null;
  /** The register the company is entered in, with a link to the entry when
   *  there is a public one per company. */
  register: { name: string; url: string | null } | null;
  /** Optional: the registered agent (shown on /legal/company). */
  registeredAgent: RegisteredAgent | null;
  /** Optional: date of incorporation, yyyy-mm-dd (shown on /legal/company). */
  incorporatedOn: string | null;
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
    registeredAgent: null,
    incorporatedOn: null,
    licence: null,
    contacts: CURRENT_CONTACTS,
    governingLaw: null,
    disputeResolution: null,
    pilotNotice:
      "The devnet pilot is not yet operated by a designated legal entity and holds no licence. Tokens on devnet have no economic value. The operator's name, registration details and licence will be published here before the mainnet launch.",
  },
  // Mainnet: Manci International Ltd., a BVI business company limited by
  // shares (BVI Business Companies Act, 2004), recorded on 2026-09-30 from
  // its Certificate of Incorporation (name, company number, date, register)
  // and its Memorandum of Association (§3 registered office, §4 registered
  // agent); the tax number, which neither document mentions, on the owner's
  // written confirmation of 2026-10-02. A mainnet build is refused unless
  // every required field is set (lib/legal/readiness.ts).
  mainnet: {
    brand: "Manci",
    legalName: "Manci International Ltd.",
    shortName: {
      notAssigned: "The Certificate of Incorporation and the Memorandum give a single registered name, with no short form.",
    },
    // The registered agent's office (memorandum §3; the directors or members
    // may move it, and this line then changes with it).
    registeredOffice: "Trinity Chambers, PO Box 4301, Road Town, Tortola, British Virgin Islands",
    registrationNumber: { value: "2219023", label: "BVI company number", shortLabel: "BVI company number" },
    // No tax identification number: neither the Certificate of
    // Incorporation nor the Memorandum mentions one, and the owner confirmed
    // in writing on 2026-10-02 that the company has none (the BVI assigns
    // none to its business companies). If one is ever assigned, record it
    // under its name ({ value, label, shortLabel }); the pages then show it.
    taxId: {
      notAssigned:
        "BVI business companies are not assigned a tax identification number; the owner confirmed in writing on 2026-10-02 that the company has none.",
    },
    // As the Certificate of Incorporation names its issuer: the text reads
    // "The REGISTRAR of CORPORATE AFFAIRS, of the British Virgin Islands",
    // and its seal (an image, not in the PDF's text layer) reads "Registrar
    // of Corporate Affairs" around "BVI Financial Services Commission".
    // url null: no public link to the company's entry is recorded.
    register: { name: "Registrar of Corporate Affairs, BVI Financial Services Commission", url: null },
    registeredAgent: {
      name: "SHRM Trustees (BVI) Limited",
      address: "Trinity Chambers, PO Box 4301, Road Town, Tortola, British Virgin Islands",
    },
    incorporatedOn: "2026-09-28",
    // No licence, on counsel's written opinion that none is needed: a mainnet
    // build then needs MAINNET_LICENSE_NOT_REQUIRED=true (runbook §17).
    licence: null,
    // Confirm these before launch: they are the addresses published today.
    // Set `support` if the company has a support mailbox (null keeps the
    // contact form as the support channel).
    contacts: CURRENT_CONTACTS,
    // Owner's decision 2026-09-30: the Terms are governed by the law of the
    // company's jurisdiction. The forum follows it (the BVI courts); change it
    // here if counsel prefers arbitration. This record is the contracting
    // party for every user of the mainnet Service (Terms clause 1: "the
    // company named as the operator on this page"), whether or not the site
    // is open to the public. Moving users of some jurisdictions to another
    // group company would need that company's own record here, the pages to
    // pick it, and a new version of the Terms, all confirmed with counsel;
    // until then nobody contracts with any other entity.
    governingLaw: "the laws of the British Virgin Islands",
    disputeResolution: "the courts of the British Virgin Islands",
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

/** True for a detail stated as not assigned by the jurisdiction. */
export function isNotAssigned(value: unknown): value is NotAssigned {
  return typeof value === "object" && value !== null && "notAssigned" in value;
}

/** The short registered name when the register has one; null otherwise (the
 *  full registered name then stands alone). */
export function operatorShortName(operator: Operator): string | null {
  const short = operator.shortName;
  return typeof short === "string" && short.trim() ? short.trim() : null;
}

/**
 * The operator's numbers that are set, registration number first, as
 * [name, number] pairs: under their names in a sentence (`"label"`, e.g.
 * "registration number (MB)") or in the footer (`"shortLabel"`, e.g. "MB").
 * A number that is not set or not assigned is left out.
 */
export function operatorNumbers(operator: Operator, form: "label" | "shortLabel"): Array<[string, string]> {
  const numbers: Array<RegisteredNumber | NotAssigned | null> = [operator.registrationNumber, operator.taxId];
  return numbers
    .filter((number): number is RegisteredNumber => number !== null && !isNotAssigned(number) && Boolean(number.value.trim()))
    .map((number) => [number[form].trim(), number.value.trim()]);
}

/** "Securities Commission of the Republic of Serbia, decision 1/2026 of 2026-10-01". */
export function licenceLine(licence: OperatorLicence): string {
  return `${licence.authority}, decision ${licence.decisionNumber} of ${licence.decisionDate}`;
}

/** The copyright holder: the registered name, or the brand without an entity. */
export function copyrightHolder(operator: Operator): string {
  return hasOperatorEntity(operator) ? operator.legalName!.trim() : operator.brand;
}

/** "<office> · MB … · PIB …" (Serbia), "<office> · BVI company number …"
 *  (the BVI) when a legal entity is named; null otherwise. */
export function operatorRegistrationLine(operator: Operator): string | null {
  if (!hasOperatorEntity(operator)) return null;
  const parts = [
    operator.registeredOffice?.trim() ?? "",
    ...operatorNumbers(operator, "shortLabel").map(([name, number]) => `${name} ${number}`),
  ].filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The footer's operator line: "© <year> <registered name> · <office> · <each
 * number under its footer name> · Licence: <authority>, decision … of …".
 * null while no legal entity operates the network (the devnet pilot): the
 * footer then shows only its link to /legal/company, which carries the pilot
 * notice.
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
 * <legal name>, registered office …, <each number under its name, e.g.
 * registration number (MB) …, tax ID (PIB) …>. Licence: …." Without an
 * entity it is the pilot notice (devnet).
 */
export function operatorSentence(operator: Operator): string | null {
  if (!hasOperatorEntity(operator)) return operator.pilotNotice;
  const parts = [`${operator.brand} is operated by ${operator.legalName!.trim()}`];
  if (operator.registeredOffice?.trim()) parts.push(`registered office ${operator.registeredOffice.trim()}`);
  for (const [name, number] of operatorNumbers(operator, "label")) parts.push(`${name} ${number}`);
  const licence = operator.licence ? ` Licence: ${licenceLine(operator.licence)}.` : "";
  return `${parts.join(", ")}.${licence}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DRAFT_MARKER_RE = /\b(TODO|TBD|XXX)\b|placeholder|to be confirmed|lorem ipsum/i;

function missing(value: string | null | undefined): boolean {
  return !value || !value.trim() || DRAFT_MARKER_RE.test(value);
}

/** What is wrong with a number (`field`) that is set. */
function numberProblems(field: string, number: RegisteredNumber): string[] {
  const problems: string[] = [];
  if (missing(number.value)) problems.push(`operator.${field}.value is not set`);
  if (missing(number.label)) {
    problems.push(`operator.${field}.label (its name in a sentence, e.g. "registration number (MB)") is not set`);
  }
  if (missing(number.shortLabel)) {
    problems.push(`operator.${field}.shortLabel (its name in the footer, e.g. "MB") is not set`);
  }
  return problems;
}

/** A detail stated as not assigned must say why. */
function notAssignedProblems(field: string, value: NotAssigned): string[] {
  return missing(value.notAssigned) ? [`operator.${field}.notAssigned must give the reason`] : [];
}

/**
 * What a mainnet build refuses in `operator`, one sentence per field; empty
 * when the record is complete. The licence is optional here — whether it may
 * be absent is decided in lib/legal/readiness.ts.
 */
export function operatorProblems(operator: Operator): string[] {
  const problems: string[] = [];
  const unset = (field: string) => problems.push(`operator.${field} is not set`);

  if (missing(operator.legalName)) unset("legalName (full registered name)");

  const short = operator.shortName;
  if (isNotAssigned(short)) problems.push(...notAssignedProblems("shortName", short));
  else if (missing(short)) unset("shortName (short registered name, or { notAssigned: <reason> })");

  if (missing(operator.registeredOffice)) unset("registeredOffice (registered office address)");

  // No exemption: every company has a registration number.
  if (operator.registrationNumber === null) unset("registrationNumber (company registration number)");
  else problems.push(...numberProblems("registrationNumber", operator.registrationNumber));

  const tax = operator.taxId;
  if (tax === null) unset("taxId (tax identification number, or { notAssigned: <reason> })");
  else if (isNotAssigned(tax)) problems.push(...notAssignedProblems("taxId", tax));
  else problems.push(...numberProblems("taxId", tax));

  if (missing(operator.register?.name ?? null)) unset("register.name (the company register)");

  // Optional details: null is allowed, anything set must be complete.
  const agent = operator.registeredAgent;
  if (agent !== null) {
    if (missing(agent.name)) unset("registeredAgent.name");
    if (missing(agent.address)) unset("registeredAgent.address");
  }
  if (operator.incorporatedOn !== null && !isIsoDate(operator.incorporatedOn)) {
    problems.push("operator.incorporatedOn must be a yyyy-mm-dd date or null");
  }

  if (missing(operator.governingLaw)) unset("governingLaw");
  if (missing(operator.disputeResolution)) unset("disputeResolution (court or arbitration)");

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
    if (!isIsoDate(licence.decisionDate)) {
      problems.push("operator.licence.decisionDate must be a yyyy-mm-dd date");
    }
    if (licence.services.length === 0 || licence.services.some((s) => missing(s))) {
      problems.push("operator.licence.services must list the licensed services");
    }
  }
  return problems;
}
