// The operator and legal slots (lib/legal/*) and the mainnet build guard over
// them (next.config.ts assertBuildMainnetLegal): a mainnet build is refused
// until the operator record, the licence (or counsel's written waiver),
// counsel's mainnet Terms, Privacy Policy and acceptance-dialog summary and
// the purchase risk warning are in place — and none of it may still read like
// the devnet pilot. Devnet keeps its texts and its Terms version.
//
// "mainnet legal slots report" prints what a mainnet build refuses today:
// run `npx vitest run tests/legal-slots.test.ts --silent=false` after filling
// a slot.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertBuildMainnetLegal } from "@/next.config";
import { ControllerSection } from "@/components/legal/controller-section";
import { OperatorCompanyDetails, OperatorContactDetails } from "@/components/legal/operator-details";
import { SecurityAuditReportLink } from "@/components/legal/security-review";
import {
  forbiddenMainnetPhrases,
  isIsoDate,
  legalDocumentProblems,
  type LegalDocument,
} from "@/lib/legal/document";
import {
  OPERATORS,
  copyrightHolder,
  operatorFooterLine,
  operatorFor,
  operatorProblems,
  operatorRegistrationLine,
  operatorSentence,
  type Operator,
} from "@/lib/legal/operator";
import {
  MAINNET_LEGAL_SLOTS,
  MAINNET_LICENSE_WAIVER,
  mainnetLegalProblems,
  type MainnetLegalSlots,
} from "@/lib/legal/readiness";
import { MAINNET_PRIVACY, MAINNET_TERMS, MAINNET_TOS_GATE_POINTS } from "@/lib/legal/mainnet-copy";
import { PURCHASE_RISK_WARNING, NO_INVESTOR_PROTECTION } from "@/lib/legal/risk-warning";
import {
  SECURITY_AUDIT,
  securityAuditReport,
  securityReviewFact,
  securityReviewStatement,
} from "@/lib/legal/audit";
import { DEVNET_TOS_VERSION, tosVersionFor } from "@/lib/tos-version";

const BUILD = "phase-production-build";
const DEV = "phase-development-server";

/** A Serbian company (the form the record was first written for): MB, PIB,
 *  a short name, the APR, a licence. */
const COMPANY: Operator = {
  brand: "Manci",
  legalName: "Manci d.o.o. Beograd",
  shortName: "Manci d.o.o.",
  registeredOffice: "Knez Mihailova 1, 11000 Belgrade, Serbia",
  registrationNumber: { value: "21000000", label: "registration number (MB)", shortLabel: "MB" },
  taxId: { value: "110000000", label: "tax ID (PIB)", shortLabel: "PIB" },
  register: { name: "Serbian Business Registers Agency (APR)", url: null },
  registeredAgent: null,
  incorporatedOn: null,
  licence: {
    authority: "Securities Commission of the Republic of Serbia",
    decisionNumber: "5/0-01-1/26",
    decisionDate: "2026-10-15",
    services: ["Operating a digital asset trading platform"],
    registerUrl: null,
  },
  contacts: { support: null, legal: "legal@example.com", privacy: "privacy@example.com", security: "security@example.com", dpo: null },
  governingLaw: "the law of the Republic of Serbia",
  disputeResolution: "the competent court in Belgrade",
  pilotNotice: null,
};

/** The committed mainnet record (Manci International Ltd., BVI), complete
 *  since 2026-10-02: the tax number is stated as not assigned on the owner's
 *  written confirmation of that day. */
const BVI: Operator = { ...OPERATORS.mainnet };

/** The approval date of counsel's mainnet texts (owner's statement, 2026-10-02). */
const APPROVED = "2026-10-02";

const TAX_ID_UNSET = "operator.taxId (tax identification number, or { notAssigned: <reason> }) is not set";

/** Nothing filled in: the devnet record without its pilot notice. */
const BLANK: Operator = { ...OPERATORS.devnet, pilotNotice: null };

/** Serbian labels, which a BVI company's pages must never show. */
const SERBIAN_LABELS = /\bMB\b|\bPIB\b|sedište|\bAPR\b/;

const DOC: LegalDocument = {
  version: "2026-11-01",
  lastUpdated: "2026-11-01",
  clauses: [
    { title: "1. Acceptance", blocks: [{ kind: "paragraph", text: "By connecting a wallet you agree to these Terms." }] },
    { title: "2. Eligibility", blocks: [{ kind: "list", items: ["You must be at least 18 years old."] }] },
  ],
};

const READY: MainnetLegalSlots = {
  operator: COMPANY,
  terms: DOC,
  privacy: { ...DOC, clauses: [{ title: "1. Data we collect", blocks: [{ kind: "paragraph", text: "Wallet addresses." }] }] },
  tosGatePoints: ["You accept the Terms of Service."],
  riskWarning: { ...PURCHASE_RISK_WARNING, status: "counsel" },
};

describe("operator record", () => {
  it("accepts a complete company and names every missing field", () => {
    expect(operatorProblems(COMPANY)).toEqual([]);
    expect(operatorProblems(BLANK)).toEqual([
      "operator.legalName (full registered name) is not set",
      "operator.shortName (short registered name, or { notAssigned: <reason> }) is not set",
      "operator.registeredOffice (registered office address) is not set",
      "operator.registrationNumber (company registration number) is not set",
      "operator.taxId (tax identification number, or { notAssigned: <reason> }) is not set",
      "operator.register.name (the company register) is not set",
      "operator.governingLaw is not set",
      "operator.disputeResolution (court or arbitration) is not set",
    ]);
  });

  it("refuses drafting leftovers, bad emails, a pilot notice and an incomplete licence", () => {
    expect(operatorProblems({ ...COMPANY, taxId: { value: "TBD", label: "tax ID (PIB)", shortLabel: "PIB" } })).toEqual([
      "operator.taxId.value is not set",
    ]);
    expect(operatorProblems({ ...COMPANY, registeredOffice: "  " })).toEqual([
      "operator.registeredOffice (registered office address) is not set",
    ]);
    expect(operatorProblems({ ...COMPANY, contacts: { ...COMPANY.contacts, legal: "legal at manci" } })).toEqual([
      "operator.contacts.legal must be an email address",
    ]);
    expect(operatorProblems({ ...COMPANY, contacts: { ...COMPANY.contacts, dpo: "nobody" } })).toEqual([
      "operator.contacts.dpo must be an email address or null",
    ]);
    expect(operatorProblems({ ...COMPANY, contacts: { ...COMPANY.contacts, support: "support desk" } })).toEqual([
      "operator.contacts.support must be an email address or null",
    ]);
    expect(operatorProblems({ ...COMPANY, pilotNotice: "Pilot" })).toEqual(["operator.pilotNotice must be null on mainnet"]);
    expect(
      operatorProblems({ ...COMPANY, licence: { ...COMPANY.licence!, decisionDate: "15.10.2026", services: [] } }),
    ).toEqual([
      "operator.licence.decisionDate must be a yyyy-mm-dd date",
      "operator.licence.services must list the licensed services",
    ]);
  });

  it("test networks share the devnet record, which states the pilot instead of a company", () => {
    for (const network of ["devnet", "testnet", "localnet"] as const) {
      expect(operatorFor(network)).toBe(OPERATORS.devnet);
    }
    expect(operatorFor("mainnet")).toBe(OPERATORS.mainnet);
    expect(OPERATORS.devnet.legalName).toBeNull();
    expect(operatorSentence(OPERATORS.devnet)).toBe(OPERATORS.devnet.pilotNotice);
    expect(operatorSentence(COMPANY)).toBe(
      "Manci is operated by Manci d.o.o. Beograd, registered office Knez Mihailova 1, 11000 Belgrade, Serbia, " +
        "registration number (MB) 21000000, tax ID (PIB) 110000000. Licence: Securities Commission of the " +
        "Republic of Serbia, decision 5/0-01-1/26 of 2026-10-15.",
    );
  });

  it("has a support slot: optional (the contact form), shown when set (review 8.1 #4, #12)", () => {
    expect(operatorProblems({ ...COMPANY, contacts: { ...COMPANY.contacts, support: null } })).toEqual([]);
    expect(operatorProblems({ ...COMPANY, contacts: { ...COMPANY.contacts, support: "support@example.com" } })).toEqual([]);
    const withSupport = renderToStaticMarkup(
      createElement(OperatorContactDetails, { operator: { ...COMPANY, contacts: { ...COMPANY.contacts, support: "support@example.com" } } }),
    );
    expect(withSupport).toContain("Support");
    expect(withSupport).toContain('href="mailto:support@example.com"');
    expect(renderToStaticMarkup(createElement(OperatorContactDetails, { operator: COMPANY }))).not.toContain(">Support<");
  });

  it("names the operator in the footer the pages actually render (review 8.1 #1)", () => {
    expect(operatorFooterLine(OPERATORS.devnet, 2026)).toBeNull();
    expect(copyrightHolder(OPERATORS.devnet)).toBe("Manci");
    expect(operatorFooterLine(COMPANY, 2027)).toBe(
      "© 2027 Manci d.o.o. Beograd · Knez Mihailova 1, 11000 Belgrade, Serbia · MB 21000000 · PIB 110000000 · " +
        "Licence: Securities Commission of the Republic of Serbia, decision 5/0-01-1/26 of 2026-10-15",
    );
    expect(operatorFooterLine({ ...COMPANY, licence: null }, 2027)).not.toContain("Licence");
    // components/app-shell.tsx is the footer every public and app page renders.
    const shell = readFileSync(join(process.cwd(), "components/app-shell.tsx"), "utf8");
    const footer = /<footer className="app-footer">[\s\S]*?<\/footer>/.exec(shell)?.[0] ?? "";
    expect(footer).toContain('href="/legal/company"');
    expect(footer).toContain("{operatorLine");
    expect(shell).toMatch(/operatorFooterLine\(operatorFor\(network\)/);
  });

  it("publishes the same security contact as public/.well-known/security.txt on every network", () => {
    const txt = readFileSync(join(process.cwd(), "public/.well-known/security.txt"), "utf8");
    const contact = /^Contact: mailto:(.+)$/m.exec(txt)?.[1]?.trim();
    expect(contact).toBeTruthy();
    expect(OPERATORS.devnet.contacts.security).toBe(contact);
    expect(OPERATORS.mainnet.contacts.security).toBe(contact);
    // …and as the security.txt embedded in both programs.
    for (const program of ["asset_registry", "transfer_hook"]) {
      const source = readFileSync(join(process.cwd(), `../program/programs/${program}/src/lib.rs`), "utf8");
      const embedded = /security_txt! \{[\s\S]*?contacts: "email:([^"]+)"/.exec(source)?.[1];
      expect(embedded, program).toBe(contact);
    }
  });
});

describe("a jurisdiction-neutral record: Manci International Ltd. (BVI) on mainnet", () => {
  it("records the company from its certificate and memorandum; the devnet record is unchanged", () => {
    const mainnet = OPERATORS.mainnet;
    expect(mainnet.brand).toBe("Manci");
    expect(mainnet.legalName).toBe("Manci International Ltd.");
    expect(mainnet.registeredOffice).toBe("Trinity Chambers, PO Box 4301, Road Town, Tortola, British Virgin Islands");
    expect(mainnet.registrationNumber).toEqual({ value: "2219023", label: "BVI company number", shortLabel: "BVI company number" });
    // The register as the certificate and its seal name the issuer.
    expect(mainnet.register).toEqual({ name: "Registrar of Corporate Affairs, BVI Financial Services Commission", url: null });
    expect(mainnet.registeredAgent?.name).toBe("SHRM Trustees (BVI) Limited");
    expect(mainnet.incorporatedOn).toBe("2026-09-28");
    // Not in the certificate or the memorandum: stated as not assigned, with
    // the reason and the date of the owner's written confirmation (runbook §17).
    expect(mainnet.taxId).toEqual({
      notAssigned: expect.stringMatching(/^BVI business companies are not assigned a tax identification number;.*confirmed in writing on 2026-10-02/),
    });
    expect(mainnet.shortName).toEqual({ notAssigned: expect.stringMatching(/\S/) });
    expect(mainnet.licence).toBeNull();
    expect(mainnet.pilotNotice).toBeNull();
    expect(OPERATORS.devnet.legalName).toBeNull();
    expect(OPERATORS.devnet.registrationNumber).toBeNull();
  });

  it("passes the operator check: complete since the owner confirmed the tax number (2026-10-02)", () => {
    expect(operatorProblems(BVI)).toEqual([]);
    expect(operatorProblems({ ...BVI, taxId: null, governingLaw: null, disputeResolution: null })).toEqual([
      TAX_ID_UNSET,
      "operator.governingLaw is not set",
      "operator.disputeResolution (court or arbitration) is not set",
    ]);
    // The committed record is complete: the tax number stated as not
    // assigned (owner, 2026-10-02); governing law and forum BVI (owner,
    // 2026-09-30).
    expect(operatorProblems(OPERATORS.mainnet)).toEqual([]);
    expect(OPERATORS.mainnet.governingLaw).toBe("the laws of the British Virgin Islands");
    expect(OPERATORS.mainnet.disputeResolution).toBe("the courts of the British Virgin Islands");
    // A reason still marked as unconfirmed is refused as well.
    expect(
      operatorProblems({ ...BVI, taxId: { notAssigned: "None appears in the incorporation documents; to be confirmed by the owner." } }),
    ).toEqual(["operator.taxId.notAssigned must give the reason"]);
  });

  it("allows no tax ID or short name only when stated on purpose, with a reason", () => {
    const unset = TAX_ID_UNSET;
    expect(operatorProblems({ ...BVI, taxId: null })).toEqual([unset]);
    expect(operatorProblems({ ...BVI, taxId: { notAssigned: "  " } })).toEqual(["operator.taxId.notAssigned must give the reason"]);
    expect(operatorProblems({ ...BVI, taxId: { notAssigned: "TBD" } })).toEqual(["operator.taxId.notAssigned must give the reason"]);
    expect(operatorProblems({ ...BVI, shortName: null })).toEqual([
      "operator.shortName (short registered name, or { notAssigned: <reason> }) is not set",
    ]);
    expect(operatorProblems({ ...BVI, shortName: { notAssigned: "" } })).toEqual(["operator.shortName.notAssigned must give the reason"]);
    // Or the full name written as the short name: a string, accepted as such.
    expect(operatorProblems({ ...BVI, shortName: "Manci International Ltd." })).toEqual([]);
    // The Serbian record is held to the same rule: a forgotten PIB or short name is refused.
    expect(operatorProblems({ ...COMPANY, taxId: null })).toEqual([unset]);
    expect(operatorProblems({ ...COMPANY, shortName: null })).toEqual([
      "operator.shortName (short registered name, or { notAssigned: <reason> }) is not set",
    ]);
  });

  it("refuses a missing registration number, its missing names, a bad incorporation date and a half registered agent", () => {
    expect(operatorProblems({ ...BVI, registrationNumber: null })).toEqual([
      "operator.registrationNumber (company registration number) is not set",
    ]);
    expect(
      operatorProblems({ ...BVI, registrationNumber: { value: "2219023", label: " ", shortLabel: "" } }),
    ).toEqual([
      'operator.registrationNumber.label (its name in a sentence, e.g. "registration number (MB)") is not set',
      'operator.registrationNumber.shortLabel (its name in the footer, e.g. "MB") is not set',
    ]);
    expect(operatorProblems({ ...BVI, registrationNumber: { ...BVI.registrationNumber!, value: "" } })).toEqual([
      "operator.registrationNumber.value is not set",
    ]);
    for (const date of ["28.09.2026", "2026-02-30", ""]) {
      expect(operatorProblems({ ...BVI, incorporatedOn: date }), date).toEqual([
        "operator.incorporatedOn must be a yyyy-mm-dd date or null",
      ]);
    }
    expect(operatorProblems({ ...BVI, incorporatedOn: null, registeredAgent: null })).toEqual([]);
    expect(operatorProblems({ ...BVI, registeredAgent: { name: "SHRM Trustees (BVI) Limited", address: "" } })).toEqual([
      "operator.registeredAgent.address is not set",
    ]);
  });

  it("names each number under its own jurisdiction's name, never MB or PIB for the BVI", () => {
    const office = "Trinity Chambers, PO Box 4301, Road Town, Tortola, British Virgin Islands";
    expect(operatorRegistrationLine(BVI)).toBe(`${office} · BVI company number 2219023`);
    expect(operatorFooterLine(BVI, 2026)).toBe(`© 2026 Manci International Ltd. · ${office} · BVI company number 2219023`);
    expect(operatorSentence(BVI)).toBe(
      `Manci is operated by Manci International Ltd., registered office ${office}, BVI company number 2219023.`,
    );
    for (const text of [operatorRegistrationLine(BVI), operatorFooterLine(BVI, 2026), operatorSentence(BVI)]) {
      expect(text).not.toMatch(SERBIAN_LABELS);
      expect(text).not.toMatch(/tax ID|notAssigned|no tax identification/i);
    }
    // The Serbian form keeps its names.
    expect(operatorRegistrationLine(COMPANY)).toBe("Knez Mihailova 1, 11000 Belgrade, Serbia · MB 21000000 · PIB 110000000");
    expect(operatorSentence(COMPANY)).toContain("registration number (MB) 21000000, tax ID (PIB) 110000000");
  });

  it("renders the company block and the Privacy Policy controller from the record", () => {
    const bvi = renderToStaticMarkup(createElement(OperatorCompanyDetails, { operator: BVI }));
    for (const text of [
      "Manci International Ltd.",
      ">BVI company number<",
      ">2219023<",
      "Registrar of Corporate Affairs, BVI Financial Services Commission",
      ">Date of incorporation<",
      ">2026-09-28<",
      ">Registered agent<",
      "SHRM Trustees (BVI) Limited",
    ]) {
      expect(bvi, text).toContain(text);
    }
    expect(bvi).not.toMatch(SERBIAN_LABELS);
    expect(bvi).not.toContain("Short name");
    expect(bvi).not.toContain("Tax ID");

    const serbian = renderToStaticMarkup(createElement(OperatorCompanyDetails, { operator: COMPANY }));
    for (const text of [">Short name<", ">Registration number (MB)<", ">21000000<", ">Tax ID (PIB)<", ">110000000<"]) {
      expect(serbian, text).toContain(text);
    }
    expect(serbian).not.toContain("Registered agent");
    expect(serbian).not.toContain("Date of incorporation");

    const controller = renderToStaticMarkup(createElement(ControllerSection, { operator: BVI }));
    expect(controller).toContain(
      "Controller of your personal data: Manci International Ltd., Trinity Chambers, PO Box 4301, Road Town, " +
        "Tortola, British Virgin Islands, BVI company number 2219023.",
    );
    expect(controller).not.toMatch(SERBIAN_LABELS);
    expect(renderToStaticMarkup(createElement(ControllerSection, { operator: COMPANY }))).toContain(
      "registration number (MB) 21000000, tax ID (PIB) 110000000.",
    );
  });

  describe("pages of a mainnet build (NEXT_PUBLIC_NETWORK=mainnet)", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it("/legal/company names Manci International Ltd. and its BVI details", async () => {
      vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
      const { default: CompanyPage } = await import("@/app/(marketing)/legal/company/page");
      const html = renderToStaticMarkup(createElement(CompanyPage));
      expect(html).toContain("Solana mainnet");
      expect(html).toContain("Manci International Ltd.");
      expect(html).toContain(">BVI company number<");
      expect(html).toContain("SHRM Trustees (BVI) Limited");
      expect(html).toContain("No licence is recorded for the operator.");
      expect(html).toContain('href="mailto:security@mancipatio.io"');
      expect(html).not.toMatch(SERBIAN_LABELS);
      expect(html).not.toContain(OPERATORS.devnet.pilotNotice!);
    });

    it("the marketing footer carries the BVI line", async () => {
      vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
      vi.resetModules();
      const { SiteFooter } = await import("@/components/mx/site-footer");
      const html = renderToStaticMarkup(createElement(SiteFooter));
      expect(html).toContain("Manci International Ltd.");
      expect(html).toContain("BVI company number 2219023");
      expect(html).not.toMatch(SERBIAN_LABELS);
    });
  });
});

describe("legal documents", () => {
  it("validates dates, empty clauses and devnet wording", () => {
    expect(isIsoDate("2026-11-01")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(legalDocumentProblems("Terms", DOC)).toEqual([]);
    expect(legalDocumentProblems("Terms", null)).toEqual([
      "Terms: counsel's mainnet text has not been added (lib/legal/mainnet-copy.ts)",
    ]);
    expect(legalDocumentProblems("Terms", { ...DOC, version: "v1" })).toEqual(["Terms: version must be a yyyy-mm-dd date"]);
    expect(
      legalDocumentProblems("Terms", { ...DOC, clauses: [{ title: "1. Scope", blocks: [{ kind: "list", items: [] }] }] }),
    ).toEqual(["Terms: has an empty clause, paragraph or list item"]);
    const devnetText: LegalDocument = {
      ...DOC,
      lede: "The current release runs on Solana devnet.",
      clauses: [{ title: "1. Pilot", blocks: [{ kind: "paragraph", text: "No real assets are tokenized. Governing law to be confirmed." }] }],
    };
    expect(legalDocumentProblems("Terms", devnetText)).toEqual([
      "Terms: contains wording that must not reach mainnet (devnet, no real assets, to be confirmed)",
    ]);
  });

  it("the phrase check is case-insensitive and matches the short markers as whole words", () => {
    expect(forbiddenMainnetPhrases("Runs on DEVNET before Mainnet Launch")).toEqual(["devnet", "before mainnet launch"]);
    expect(forbiddenMainnetPhrases("todo: fix")).toEqual(["TODO"]);
    expect(forbiddenMainnetPhrases("mastodon outbid")).toEqual([]);
  });
});

describe("mainnetLegalProblems", () => {
  it("is empty when every slot is complete", () => {
    expect(mainnetLegalProblems({}, READY)).toEqual([]);
  });

  it("requires the licence, or counsel's waiver — never both", () => {
    const unlicensed = { ...READY, operator: { ...COMPANY, licence: null } };
    expect(mainnetLegalProblems({}, unlicensed)).toEqual([
      expect.stringMatching(/^operator\.licence is not recorded.*MAINNET_LICENSE_NOT_REQUIRED=true only on counsel's written opinion/),
    ]);
    expect(mainnetLegalProblems({ [MAINNET_LICENSE_WAIVER]: "1" }, unlicensed)).toHaveLength(1);
    expect(mainnetLegalProblems({ [MAINNET_LICENSE_WAIVER]: " true " }, unlicensed)).toEqual([]);
    expect(mainnetLegalProblems({ [MAINNET_LICENSE_WAIVER]: "true" }, READY)).toEqual([
      expect.stringMatching(/recorded and MAINNET_LICENSE_NOT_REQUIRED=true says none is needed/),
    ]);
  });

  it("requires counsel's Terms, Privacy Policy, dialog summary and risk warning without devnet wording", () => {
    expect(mainnetLegalProblems({}, { ...READY, terms: null, privacy: null })).toEqual([
      "Terms of Service: counsel's mainnet text has not been added (lib/legal/mainnet-copy.ts)",
      "Privacy Policy: counsel's mainnet text has not been added (lib/legal/mainnet-copy.ts)",
    ]);
    expect(mainnetLegalProblems({}, { ...READY, tosGatePoints: null })).toEqual([
      expect.stringMatching(/^Terms acceptance dialog: counsel's summary/),
    ]);
    expect(mainnetLegalProblems({}, { ...READY, tosGatePoints: ["Assets here have no economic value."] })).toEqual([
      "Terms acceptance dialog: contains wording that must not reach mainnet (no economic value)",
    ]);
    expect(mainnetLegalProblems({}, { ...READY, riskWarning: { ...PURCHASE_RISK_WARNING, status: "draft" } })).toEqual([
      expect.stringMatching(/^Purchase risk warning: still engineering's draft/),
    ]);
  });

  it("mainnet legal slots report (what a mainnet build refuses today)", () => {
    // No licence is recorded, on counsel's written opinion that none is
    // needed: a mainnet build sets MAINNET_LICENSE_NOT_REQUIRED=true.
    const problems = mainnetLegalProblems({ [MAINNET_LICENSE_WAIVER]: "true" }, MAINNET_LEGAL_SLOTS);
    console.info(
      problems.length === 0
        ? `[legal slots] complete: a mainnet build with ${MAINNET_LICENSE_WAIVER}=true is not refused by lib/legal/`
        : `[legal slots] a mainnet build is refused until:\n  - ${problems.join("\n  - ")}`,
    );
    // Complete since 2026-10-02: the company (Manci International Ltd., BVI,
    // recorded 2026-09-30, its tax number stated as not assigned on the
    // owner's written confirmation of 2026-10-02) and counsel's Terms, Privacy
    // Policy, dialog summary and risk warning (approved, per the owner,
    // 2026-10-02).
    expect(problems).toEqual([]);
    // Without counsel's waiver the licence is the one refusal.
    expect(mainnetLegalProblems({}, MAINNET_LEGAL_SLOTS)).toEqual([
      expect.stringMatching(/^operator\.licence is not recorded/),
    ]);
  });
});

describe("assertBuildMainnetLegal (next.config.ts)", () => {
  it("passes a mainnet production build with the slots committed today and counsel's licence waiver, refuses it without", () => {
    const env = { NEXT_PUBLIC_NETWORK: "mainnet", MAINNET_LEGAL_COPY_APPROVED: "true" };
    expect(() => assertBuildMainnetLegal(BUILD, { ...env, [MAINNET_LICENSE_WAIVER]: "true" })).not.toThrow();
    let message = "";
    try {
      assertBuildMainnetLegal(BUILD, env);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/^Refusing a mainnet build: the operator and legal slots are not complete/);
    expect(message).toContain("operator.licence is not recorded");
    for (const settled of ["operator.taxId", "operator.governingLaw", "operator.disputeResolution", "Terms of Service:", "Privacy Policy:", "Terms acceptance dialog:", "Purchase risk warning:"]) {
      expect(message, settled).not.toContain(settled);
    }
  });

  it("passes a mainnet build with complete slots, and never checks other networks or phases", () => {
    expect(() => assertBuildMainnetLegal(BUILD, { NEXT_PUBLIC_NETWORK: " Mainnet " }, READY)).not.toThrow();
    for (const network of ["devnet", "testnet", "localnet", ""]) {
      expect(() => assertBuildMainnetLegal(BUILD, { NEXT_PUBLIC_NETWORK: network })).not.toThrow();
    }
    expect(() => assertBuildMainnetLegal(DEV, { NEXT_PUBLIC_NETWORK: "mainnet" })).not.toThrow();
  });
});

describe("next.config.ts runs the legal guard (review 8.1 #9)", () => {
  // config() stops at the mainnet Supabase guard while no mainnet project is
  // recorded, so a behavioural test cannot reach this guard through it yet;
  // the wiring is checked on the source instead: every exported build guard
  // is called from config(), before the config is returned.
  it("calls every exported assertBuild* guard, assertBuildMainnetLegal included", () => {
    const source = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
    const body = /export default function config\(phase: string\): NextConfig \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
    const guards = [...source.matchAll(/export function (assertBuild\w+)\(/g)].map((m) => m[1]);
    expect(guards).toContain("assertBuildMainnetLegal");
    const returnAt = body.indexOf("return nextConfig");
    expect(returnAt).toBeGreaterThan(0);
    for (const guard of guards) {
      const at = body.indexOf(`${guard}(phase);`);
      expect(at, guard).toBeGreaterThanOrEqual(0);
      expect(at, guard).toBeLessThan(returnAt);
    }
  });

  it("checks a build that would run as mainnet from the RPC URL alone (review 8.1 #7)", () => {
    expect(() =>
      assertBuildMainnetLegal(BUILD, { NEXT_PUBLIC_SOLANA_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=x" }),
    ).toThrow(/^Refusing a mainnet build: the operator and legal slots are not complete/);
    expect(() =>
      assertBuildMainnetLegal(BUILD, { NEXT_PUBLIC_SOLANA_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=x" }, READY),
    ).not.toThrow();
    expect(() =>
      assertBuildMainnetLegal(BUILD, { NEXT_PUBLIC_SOLANA_RPC_URL: "https://api.devnet.solana.com" }),
    ).not.toThrow();
  });
});

describe("Terms version per network", () => {
  it("keeps the devnet version and takes counsel's published version on mainnet (2026-10-02)", () => {
    expect(DEVNET_TOS_VERSION).toBe("2026-07-18");
    for (const network of ["devnet", "testnet", "localnet"] as const) {
      expect(tosVersionFor(network)).toBe(DEVNET_TOS_VERSION);
    }
    expect(MAINNET_TERMS?.version).toBe(APPROVED);
    expect(MAINNET_TERMS?.lastUpdated).toBe(APPROVED);
    expect(tosVersionFor("mainnet")).toBe(APPROVED);
  });

  describe("the version a build asks wallets to accept (TOS_VERSION, the acceptance dialog's v<version>)", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it("is counsel's 2026-10-02 on a mainnet build and the pilot's on devnet", async () => {
      vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
      vi.resetModules();
      expect((await import("@/lib/tos-version")).TOS_VERSION).toBe(APPROVED);
      vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
      vi.resetModules();
      expect((await import("@/lib/tos-version")).TOS_VERSION).toBe(DEVNET_TOS_VERSION);
      // The dialog shows that version and, on mainnet, counsel's summary.
      const gate = readFileSync(join(process.cwd(), "components/tos-gate.tsx"), "utf8");
      expect(gate).toContain("(MAINNET_TOS_GATE_POINTS ?? [])");
      expect(gate).toContain("Terms of Service (v{TOS_VERSION})");
    });
  });
});

/** The visible text of rendered markup: tags dropped, entities decoded. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");
}

describe("counsel's mainnet texts (approved 2026-10-02, owner's statement)", () => {
  const NEW_CLAUSE_11 =
    "wallet signatures for administrative actions; our company's hardware wallet, which holds the super administrator, " +
    "KYC authority and Blocklist Authority roles and the treasury; and a multisig, with a separate hardware wallet as its " +
    "member, that holds the authority to upgrade the on-chain programs. A second administrator uses a software wallet.";

  it("are in the slots, dated 2026-10-02, complete and free of test-network wording", () => {
    expect(MAINNET_TERMS).not.toBeNull();
    expect(MAINNET_PRIVACY).not.toBeNull();
    expect(legalDocumentProblems("Terms of Service", MAINNET_TERMS)).toEqual([]);
    expect(legalDocumentProblems("Privacy Policy", MAINNET_PRIVACY)).toEqual([]);
    expect(MAINNET_TERMS!.clauses.map((c) => c.title)).toHaveLength(21);
    expect(MAINNET_TERMS!.clauses[0].title).toBe("1. Acceptance and scope");
    expect(MAINNET_TERMS!.clauses[20].title).toBe("21. General");
    expect(MAINNET_PRIVACY!.clauses).toHaveLength(14);
    expect([MAINNET_PRIVACY!.version, MAINNET_PRIVACY!.lastUpdated]).toEqual([APPROVED, APPROVED]);
    expect(MAINNET_TOS_GATE_POINTS).toHaveLength(5);
    expect(forbiddenMainnetPhrases(MAINNET_TOS_GATE_POINTS!.join("\n"))).toEqual([]);
    // The Terms' risk clause spells out the constant the risk warning uses.
    const risks = MAINNET_TERMS!.clauses.find((c) => c.title === "12. Risks")!;
    expect(risks.blocks).toContainEqual({ kind: "paragraph", text: NO_INVESTOR_PROTECTION });
  });

  it("Privacy clause 11 names which keys a hardware wallet holds, and only that changed", () => {
    const security = MAINNET_PRIVACY!.clauses.find((c) => c.title === "11. Security")!;
    expect(security.blocks).toHaveLength(2);
    const first = security.blocks[0];
    expect(first.kind).toBe("paragraph");
    const text = first.kind === "paragraph" ? first.text : "";
    expect(text.startsWith("We protect personal data with technical and organisational measures appropriate to the risk, including: encrypted connections;")).toBe(true);
    expect(text.endsWith(NEW_CLAUSE_11)).toBe(true);
    expect(text).not.toContain("hardware wallets for the keys that control the platform");
  });

  it("the purchase risk warning is counsel's", () => {
    expect(PURCHASE_RISK_WARNING.status).toBe("counsel");
    expect(PURCHASE_RISK_WARNING.points).toHaveLength(10);
    expect(PURCHASE_RISK_WARNING.points[1]).toBe(NO_INVESTOR_PROTECTION);
    expect(forbiddenMainnetPhrases([PURCHASE_RISK_WARNING.title, ...PURCHASE_RISK_WARNING.points, PURCHASE_RISK_WARNING.acknowledgement].join("\n"))).toEqual([]);
  });

  describe("pages of a mainnet build render them (NEXT_PUBLIC_NETWORK=mainnet)", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it("/legal/terms: the operator block, counsel's 21 clauses dated 2026-10-02, governing law and the legal contact", async () => {
      vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
      vi.resetModules();
      const { default: TermsPage } = await import("@/app/(marketing)/legal/terms/page");
      const text = visibleText(renderToStaticMarkup(createElement(TermsPage)));
      expect(text).toContain(`Last updated: ${APPROVED}`);
      expect(text).toContain(MAINNET_TERMS!.lede!);
      expect(text).toContain("Manci is operated by Manci International Ltd., registered office Trinity Chambers");
      for (const clause of MAINNET_TERMS!.clauses) expect(text, clause.title).toContain(clause.title);
      expect(text).toContain("These Terms are governed by the laws of the British Virgin Islands.");
      expect(text).toContain("Disputes are resolved by the courts of the British Virgin Islands.");
      expect(text).toContain("legal@mancipatio.io");
      expect(text).not.toContain("This document has not been published yet.");
      expect(forbiddenMainnetPhrases(text)).toEqual([]);
      expect(text).not.toMatch(SERBIAN_LABELS);
    });

    it("/legal/privacy: the controller block and counsel's 14 clauses dated 2026-10-02, clause 11 as narrowed", async () => {
      vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
      vi.resetModules();
      const { default: PrivacyPage } = await import("@/app/(marketing)/legal/privacy/page");
      const text = visibleText(renderToStaticMarkup(createElement(PrivacyPage)));
      expect(text).toContain(`Last updated: ${APPROVED}`);
      expect(text).toContain("Controller of your personal data: Manci International Ltd.");
      for (const clause of MAINNET_PRIVACY!.clauses) expect(text, clause.title).toContain(clause.title);
      expect(text).toContain(NEW_CLAUSE_11);
      expect(text).not.toContain("This document has not been published yet.");
      expect(forbiddenMainnetPhrases(text)).toEqual([]);
      expect(text).not.toMatch(SERBIAN_LABELS);
    });

    it("devnet keeps the pilot's texts", async () => {
      vi.stubEnv("NEXT_PUBLIC_NETWORK", "devnet");
      vi.resetModules();
      const { default: TermsPage } = await import("@/app/(marketing)/legal/terms/page");
      const { default: PrivacyPage } = await import("@/app/(marketing)/legal/privacy/page");
      expect(visibleText(renderToStaticMarkup(createElement(TermsPage)))).not.toContain("2. The closed pilot");
      expect(visibleText(renderToStaticMarkup(createElement(PrivacyPage)))).not.toContain(NEW_CLAUSE_11);
    });
  });

});

describe("program security and risk wording", () => {
  it("claims no external audit before one is recorded", () => {
    if (SECURITY_AUDIT === null) {
      expect(securityReviewStatement()).toMatch(/internal security reviews[\s\S]*No independent external audit has been completed yet/);
      expect(securityReviewFact()).toMatch(/no external audit completed yet/);
    }
    const audit = { firm: "Example Audits", scope: "both programs at v1.0.0", completedOn: "2026-12-01", reportUrl: "https://example.com/r.pdf" };
    expect(securityReviewStatement(audit)).toMatch(/audited by Example Audits \(both programs at v1\.0\.0\)/);
    expect(securityReviewFact(audit)).toBe("Externally audited by Example Audits (2026-12-01)");
    for (const page of ["app/(marketing)/risks/page.tsx", "app/(marketing)/about/page.tsx"]) {
      expect(readFileSync(join(process.cwd(), page), "utf8"), page).not.toMatch(/systematic security review/);
    }
  });

  it("links the audit report once an audit is recorded, from /risks and /about (review 8.1 #3, #11)", () => {
    const audit = { firm: "Example Audits", scope: "both programs at v1.0.0", completedOn: "2026-12-01", reportUrl: "https://example.com/r.pdf" };
    expect(securityAuditReport(null)).toBeNull();
    expect(securityAuditReport(audit)).toEqual({
      href: "https://example.com/r.pdf",
      label: "Read the Example Audits audit report (2026-12-01)",
    });
    const link = renderToStaticMarkup(createElement(SecurityAuditReportLink, { audit }));
    expect(link).toContain('href="https://example.com/r.pdf"');
    expect(link).toContain('rel="noopener noreferrer"');
    expect(renderToStaticMarkup(createElement(SecurityAuditReportLink, { audit: null }))).toBe("");
    if (SECURITY_AUDIT) expect(SECURITY_AUDIT.reportUrl).toMatch(/^https:\/\//);
    for (const page of ["app/(marketing)/risks/page.tsx", "app/(marketing)/about/page.tsx"]) {
      expect(readFileSync(join(process.cwd(), page), "utf8"), page).toMatch(/<SecurityAuditReportLink /);
    }
  });

  it("the purchase risk warning states total loss and the absence of deposit insurance / investor protection", () => {
    const text = PURCHASE_RISK_WARNING.points.join("\n");
    expect(text).toMatch(/lose part or all/);
    expect(PURCHASE_RISK_WARNING.points).toContain(NO_INVESTOR_PROTECTION);
    expect(NO_INVESTOR_PROTECTION).toMatch(/deposit insurance.*investor protection/);
  });
});

describe("no CI fixture in the committed tree (scripts/ci/mainnet-build.sh, review 8.4 #8)", () => {
  // mainnet-build.sh writes an invented operator ("CI Fixture d.o.o.") into
  // lib/legal/ and a placeholder Supabase ref into next.config.ts, and
  // restores them on exit. A run killed where no trap fires leaves them in
  // place; the fixture passes every mainnet build guard by design, so once
  // counsel's slots are committed nothing else would notice a leftover.
  const MARKERS = ["CI FIXTURE (scripts/ci/mainnet-build.sh)", "CI Fixture", "cimainnetplaceholder"];

  it("no lib/legal/*.ts file and not next.config.ts holds the fixture", () => {
    const files = [
      ...readdirSync(join(process.cwd(), "lib/legal")).filter((f) => f.endsWith(".ts")).map((f) => `lib/legal/${f}`),
      "next.config.ts",
    ];
    expect(files).toContain("lib/legal/operator.ts");
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      for (const marker of MARKERS) expect(source.includes(marker), `${file} contains "${marker}"`).toBe(false);
    }
  });

  it("the script refuses to start on the same markers it writes", () => {
    const script = readFileSync(join(process.cwd(), "scripts/ci/mainnet-build.sh"), "utf8");
    expect(script).toContain('FIXTURE_MARKER="CI FIXTURE (scripts/ci/mainnet-build.sh)"');
    expect(script).toContain('PLACEHOLDER_REF="cimainnetplaceholder"');
    expect(script).toContain('const HEADER = "// ── CI FIXTURE (scripts/ci/mainnet-build.sh):');
    expect(script).toContain('legalName: "CI Fixture d.o.o. Beograd"');
  });
});
