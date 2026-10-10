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
  legalDocumentText,
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
import { moduleDisabledMessage, moduleEnabled } from "@/lib/features";
import { MAINNET_RAISE_CAP_EUR, maxRaiseCapEur } from "@/lib/raise-cap";
import { RAISE_LIMIT_NOTE, equityOfferedNote, whatYouAreBuying } from "@/lib/deal-terms-copy";
import { modulesFact } from "@/lib/module-facts";
import { ASSET_TYPES } from "@/lib/asset-types";
import { INSTRUMENT_LIST } from "@/lib/instruments";

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

/** The version and date of the mainnet Terms and Privacy Policy: 2026-10-03,
 *  the owner's decisions D1-D7 (open classes, public sales, platform-linked
 *  wallets, KYC at conversion). It replaced counsel's texts of 2026-10-02;
 *  counsel confirmed its exact wording on 2026-10-03 (PR #57). */
const MAINNET_VERSION = "2026-10-03";

/** The previous mainnet Terms version, which every wallet must accept again. */
const PREVIOUS_MAINNET_VERSION = "2026-10-02";

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

  it("mainnet legal slots report (complete since counsel confirmed 2026-10-03)", () => {
    // No licence is recorded, on counsel's written opinion that none is
    // needed: a mainnet build sets MAINNET_LICENSE_NOT_REQUIRED=true.
    const problems = mainnetLegalProblems({ [MAINNET_LICENSE_WAIVER]: "true" }, MAINNET_LEGAL_SLOTS);
    console.info(
      problems.length === 0
        ? `[legal slots] complete: a mainnet build with ${MAINNET_LICENSE_WAIVER}=true is not refused by lib/legal/`
        : `[legal slots] a mainnet build is refused until:\n  - ${problems.join("\n  - ")}`,
    );
    // The company (Manci International Ltd., BVI, recorded 2026-09-30, its
    // tax number stated as not assigned on the owner's written confirmation
    // of 2026-10-02) and the Terms, Privacy Policy and dialog summary are
    // complete. Counsel confirmed the exact wording of version 2026-10-03
    // (the owner's decisions D1-D7; owner, 2026-10-03, PR #57): the risk
    // warning's status is "counsel", so nothing is refused.
    expect(problems).toEqual([]);
    // Without counsel's waiver the licence is refused.
    expect(mainnetLegalProblems({}, MAINNET_LEGAL_SLOTS)).toEqual([
      expect.stringMatching(/^operator\.licence is not recorded/),
    ]);
    // Everything else is complete: with counsel's status the slots pass.
    expect(
      mainnetLegalProblems(
        { [MAINNET_LICENSE_WAIVER]: "true" },
        { ...MAINNET_LEGAL_SLOTS, riskWarning: { ...MAINNET_LEGAL_SLOTS.riskWarning, status: "counsel" } },
      ),
    ).toEqual([]);
  });
});

describe("assertBuildMainnetLegal (next.config.ts)", () => {
  it("builds the slots committed today (counsel confirmed the 2026-10-03 wording) and still refuses a draft risk warning", () => {
    const env = { NEXT_PUBLIC_NETWORK: "mainnet", MAINNET_LEGAL_COPY_APPROVED: "true" };
    const refusal = (vars: Record<string, string>, slots = MAINNET_LEGAL_SLOTS) => {
      try {
        assertBuildMainnetLegal(BUILD, vars, slots);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return "";
    };
    // Counsel confirmed the 2026-10-03 wording: with the licence waiver the committed slots build.
    expect(refusal({ ...env, [MAINNET_LICENSE_WAIVER]: "true" })).toBe("");
    // A draft risk warning would still be refused.
    const draft = { ...MAINNET_LEGAL_SLOTS, riskWarning: { ...MAINNET_LEGAL_SLOTS.riskWarning, status: "draft" as const } };
    expect(refusal({ ...env, [MAINNET_LICENSE_WAIVER]: "true" }, draft)).toContain("Purchase risk warning: still engineering's draft");
    // Counsel's status (the commit that records the confirmation) lets it through.
    const confirmed = { ...MAINNET_LEGAL_SLOTS, riskWarning: { ...MAINNET_LEGAL_SLOTS.riskWarning, status: "counsel" as const } };
    expect(refusal({ ...env, [MAINNET_LICENSE_WAIVER]: "true" }, confirmed)).toBe("");
    // Without the waiver the licence is refused as well.
    const message = refusal(env, confirmed);
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
  it("keeps the devnet version and takes the published mainnet Terms' version on mainnet (2026-10-03)", () => {
    expect(DEVNET_TOS_VERSION).toBe("2026-07-18");
    for (const network of ["devnet", "testnet", "localnet"] as const) {
      expect(tosVersionFor(network)).toBe(DEVNET_TOS_VERSION);
    }
    expect(MAINNET_TERMS?.version).toBe(MAINNET_VERSION);
    expect(MAINNET_TERMS?.lastUpdated).toBe(MAINNET_VERSION);
    expect(tosVersionFor("mainnet")).toBe(MAINNET_VERSION);
    // A new version: an acceptance of 2026-10-02 no longer counts, so every
    // mainnet wallet accepts again (Terms clause 20).
    expect(tosVersionFor("mainnet")).not.toBe(PREVIOUS_MAINNET_VERSION);
  });

  describe("the version a build asks wallets to accept (TOS_VERSION, the acceptance dialog's v<version>)", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it("is 2026-10-03 on a mainnet build and the pilot's on devnet", async () => {
      vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
      vi.resetModules();
      expect((await import("@/lib/tos-version")).TOS_VERSION).toBe(MAINNET_VERSION);
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

describe("the mainnet texts (version 2026-10-03: counsel's of 2026-10-02 changed per the owner's decisions D1-D7)", () => {
  const NEW_CLAUSE_11 =
    "wallet signatures for administrative actions; our company's hardware wallet, which holds the super administrator, " +
    "KYC authority and Blocklist Authority roles and the treasury; and a multisig, with a separate hardware wallet as its " +
    "member, that holds the authority to upgrade the on-chain programs. A second administrator uses a software wallet.";

  it("are in the slots, dated 2026-10-03, complete and free of test-network wording", () => {
    expect(MAINNET_TERMS).not.toBeNull();
    expect(MAINNET_PRIVACY).not.toBeNull();
    expect(legalDocumentProblems("Terms of Service", MAINNET_TERMS)).toEqual([]);
    expect(legalDocumentProblems("Privacy Policy", MAINNET_PRIVACY)).toEqual([]);
    expect(MAINNET_TERMS!.clauses.map((c) => c.title)).toHaveLength(21);
    expect(MAINNET_TERMS!.clauses[0].title).toBe("1. Acceptance and scope");
    expect(MAINNET_TERMS!.clauses[20].title).toBe("21. General");
    expect(MAINNET_PRIVACY!.clauses).toHaveLength(14);
    expect([MAINNET_PRIVACY!.version, MAINNET_PRIVACY!.lastUpdated]).toEqual([MAINNET_VERSION, MAINNET_VERSION]);
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

  it("the purchase risk warning carries counsel's status (confirmed 2026-10-03)", () => {
    expect(PURCHASE_RISK_WARNING.status).toBe("counsel");
    expect(PURCHASE_RISK_WARNING.points).toHaveLength(10);
    expect(PURCHASE_RISK_WARNING.points[1]).toBe(NO_INVESTOR_PROTECTION);
    expect(forbiddenMainnetPhrases([PURCHASE_RISK_WARNING.title, ...PURCHASE_RISK_WARNING.points, PURCHASE_RISK_WARNING.acknowledgement].join("\n"))).toEqual([]);
  });

  it("state the owner's decisions D1-D7 and no longer describe a closed pilot", () => {
    const clause = (title: string) => {
      const found = MAINNET_TERMS!.clauses.find((c) => c.title === title);
      expect(found, title).toBeDefined();
      return legalDocumentText({ version: MAINNET_VERSION, lastUpdated: MAINNET_VERSION, clauses: [found!] });
    };
    const terms = legalDocumentText(MAINNET_TERMS!);
    const privacy = legalDocumentText(MAINNET_PRIVACY!);
    const risk = PURCHASE_RISK_WARNING.points.join("\n");
    // Nothing on mainnet speaks of a pilot or of invited buyers any more.
    for (const [name, text] of [["Terms", terms], ["Privacy", privacy], ["dialog", MAINNET_TOS_GATE_POINTS!.join("\n")], ["risk warning", risk]]) {
      expect(text, name).not.toMatch(/\bpilot\b/i);
      expect(text, name).not.toMatch(/\binvited\b/i);
    }
    expect(MAINNET_TERMS!.clauses[1].title).toBe("2. Scope of the Service");
    // D1 + D3: open classes need no KYC to buy, hold or transfer; KYC at conversion and delivery.
    expect(clause("6. Identity verification and the investor passport")).toContain(
      "Buying, holding and transferring units of an open class (a class that is not KYC-gated) need no identity verification.",
    );
    expect(clause("6. Identity verification and the investor passport")).toContain(
      "Identity verification (KYC) is required to convert tokens into company shares, where the issuer offers conversion,",
    );
    // D2: a wallet linked to the platform, nothing more; buying around it is not supported.
    const sales = clause("7. Primary sales");
    expect(sales).toContain("You can buy units in a primary sale only through the Service.");
    expect(sales).toContain("Nothing more is required to buy units of an open class");
    expect(sales).toContain("is not supported. The Operator monitors purchases on the blockchain.");
    expect(clause("14. Prohibited use")).toContain("buying in a primary sale other than through the Service (clause 7);");
    expect(MAINNET_TOS_GATE_POINTS![0]).toMatch(/^You can buy in a primary sale only on the Manci site, with this wallet signed in, these Terms accepted and sanctions screening passed\./);
    // D4: public sales of up to 365 days, the EUR 3M cap, final purchases.
    expect(sales).toContain("Primary sales are open to the public; no invitation is needed.");
    expect(sales).toContain("up to 365 days");
    expect(sales).toContain("EUR 3,000,000 over any period of twelve months; where an issuer issues through a special purpose vehicle, the limit applies to that vehicle.");
    expect(sales).toContain("A confirmed purchase is final");
    // D5: issuer direct transfers from the treasury.
    expect(sales).toContain("An issuer may also transfer units from its treasury directly to wallets it chooses.");
    // D6: trading through Manci and the other modules stay off; conversion only where the issuer offers it.
    const scope = clause("2. Scope of the Service");
    expect(scope).toContain("Trading through Manci (OTC deals, offers and the resell board), vested (Startup) raises");
    expect(scope).not.toMatch(/conversion into company shares, physical delivery/);
    expect(scope).toContain("The following are not available at present, and the pages that carry them say so:");
    expect(scope).toContain("Conversion of tokens into company shares. Once the Operator switches it on, it will be available where the issuer offers it");
  });

  describe("hold to what the code does on mainnet (review of PR #57)", () => {
    const PREFIX = "NEXT_PUBLIC_FEATURE_";
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("conversion is not presented as offered while its module is off", () => {
      vi.stubEnv(`${PREFIX}CUSTODY_CONVERSION`, "");
      expect(moduleEnabled("custodyConversion", "mainnet")).toBe(false);
      const scope = MAINNET_TERMS!.clauses.find((c) => c.title === "2. Scope of the Service")!;
      // The list after "currently offers the following" names primary sales and issuer transfers only.
      const offeredAt = scope.blocks.findIndex((b) => b.kind === "paragraph" && b.text === "The Service currently offers the following:");
      const offered = scope.blocks[offeredAt + 1];
      expect(offered.kind === "list" ? offered.items : []).toHaveLength(2);
      expect(offered.kind === "list" ? offered.items.join("\n") : "").not.toMatch(/conver/i);
      const risks = legalDocumentText({ version: MAINNET_VERSION, lastUpdated: MAINNET_VERSION, clauses: [MAINNET_TERMS!.clauses.find((c) => c.title === "12. Risks")!] });
      expect(risks).toContain("Conversion into company shares is not available yet (clause 2); once it is, it will be available only where the issuer offers it");
      expect(PURCHASE_RISK_WARNING.points[9]).toMatch(/^Converting tokens into company shares, where conversion is available and the issuer offers it, /);
      // Its page says so (the notice "clause 2" points to).
      expect(moduleDisabledMessage("custodyConversion", "mainnet")).toBe("Conversion into company shares: not available on Solana mainnet.");
      // No mainnet text says conversion is available today.
      for (const text of [legalDocumentText(MAINNET_TERMS!), legalDocumentText(MAINNET_PRIVACY!), MAINNET_TOS_GATE_POINTS!.join("\n"), PURCHASE_RISK_WARNING.points.join("\n")]) {
        expect(text).not.toMatch(/Conversion into company shares is available only/);
        expect(text).not.toMatch(/Conversion of tokens into company shares, where the issuer offers it\./);
      }
    });

    it("buying outside the Service means a purchase in a primary sale, never an issuer's direct transfer or a wallet-to-wallet one", () => {
      const texts: Record<string, string> = {
        Terms: legalDocumentText(MAINNET_TERMS!),
        Privacy: legalDocumentText(MAINNET_PRIVACY!),
        dialog: MAINNET_TOS_GATE_POINTS!.join("\n"),
        "risk warning": PURCHASE_RISK_WARNING.points.join("\n"),
      };
      const offPlatform = /\b(outside|other than through) the (Service|platform|Manci site)\b|\bbuy only\b|\bbuying in any other way\b/i;
      let found = 0;
      for (const [name, text] of Object.entries(texts)) {
        // Sentences (and list items) that speak of buying around the Service.
        for (const sentence of text.split(/(?<=[.;])\s+|\n/)) {
          if (!offPlatform.test(sentence)) continue;
          found++;
          expect(sentence, `${name}: ${sentence}`).toMatch(/primary sale/);
        }
      }
      expect(found).toBeGreaterThanOrEqual(10);
      const sales = legalDocumentText({ version: MAINNET_VERSION, lastUpdated: MAINNET_VERSION, clauses: [MAINNET_TERMS!.clauses.find((c) => c.title === "7. Primary sales")!] });
      expect(sales).toContain(
        "Units you receive through an issuer's direct transfer (described below) or by a transfer from another wallet (clause 8) are not a purchase in a primary sale.",
      );
    });

    it("the EUR 3,000,000 limit is the ceiling the admin routes keep on mainnet, per issuer or per SPV as 0066 counts it", () => {
      expect(MAINNET_RAISE_CAP_EUR).toBe(3_000_000);
      expect(maxRaiseCapEur("mainnet")).toBe(MAINNET_RAISE_CAP_EUR);
      expect(maxRaiseCapEur("devnet")).toBeGreaterThan(MAINNET_RAISE_CAP_EUR);
      const migration = readFileSync(join(process.cwd(), "supabase/migrations/0066_sale_capacity.sql"), "utf8");
      expect(migration).toMatch(/'spv:<spvs\.id>'\s+when the asset is issued through an SPV/);
      expect(migration).toContain("window_start timestamptz := now() - interval '12 months';");
      for (const route of ["app/api/admin-config/raise-limits/route.ts", "app/api/clients/raise-limits/route.ts"]) {
        const source = readFileSync(join(process.cwd(), route), "utf8");
        expect(source, route).toMatch(/"Annual raise cap", 1, maxRaiseCapEur\(/);
        expect(source, route).not.toContain("1_000_000_000_000");
      }
    });
  });

  describe("pages of a mainnet build render them (NEXT_PUBLIC_NETWORK=mainnet)", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it("/legal/terms: the operator block, the 21 clauses dated 2026-10-03, governing law and the legal contact", async () => {
      vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
      vi.resetModules();
      const { default: TermsPage } = await import("@/app/(marketing)/legal/terms/page");
      const text = visibleText(renderToStaticMarkup(createElement(TermsPage)));
      expect(text).toContain(`Last updated: ${MAINNET_VERSION}`);
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

    it("/legal/privacy: the controller block and the 14 clauses dated 2026-10-03, clause 11 as narrowed", async () => {
      vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
      vi.resetModules();
      const { default: PrivacyPage } = await import("@/app/(marketing)/legal/privacy/page");
      const text = visibleText(renderToStaticMarkup(createElement(PrivacyPage)));
      expect(text).toContain(`Last updated: ${MAINNET_VERSION}`);
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
      expect(visibleText(renderToStaticMarkup(createElement(TermsPage)))).not.toContain("2. Scope of the Service");
      expect(visibleText(renderToStaticMarkup(createElement(PrivacyPage)))).not.toContain(NEW_CLAUSE_11);
    });
  });

});

describe("mainnet pages do not contradict the Terms (review of PR #57)", () => {
  // The Terms of 2026-10-03 (lib/legal/mainnet-copy.ts): units are bearer
  // share-class tokens (clause 5); conversion into company shares is not
  // available yet and, once it is, only where the issuer offers it, after KYC
  // (clauses 2, 6 and 12); trading through Manci, distributions, delivery,
  // governance and vesting are switched off (clause 2); EUR 3,000,000 per
  // issuer over any twelve months (clause 7). Pages shared with devnet must
  // hold on mainnet too.
  const MODULE_VARS = ["SECONDARY_TRADING", "GOVERNANCE", "VESTING", "DISTRIBUTIONS", "CUSTODY_CONVERSION", "CUSTODY_DELIVERY"];
  const modulesOff = () => {
    for (const name of MODULE_VARS) vi.stubEnv(`NEXT_PUBLIC_FEATURE_${name}`, "");
  };
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** Every string in a value (React elements skipped). */
  const strings = (value: unknown): string[] => {
    if (typeof value === "string") return [value];
    if (!value || typeof value !== "object" || "$$typeof" in value) return [];
    return Object.values(value).flatMap(strings);
  };

  it("the sale page's Deal terms describe bearer share-class tokens, conversion where offered and the EUR limit", () => {
    modulesOff();
    const mature = whatYouAreBuying({
      isStartup: false,
      structure: "SAFE",
      conversionAvailable: moduleEnabled("custodyConversion", "mainnet"),
      network: "mainnet",
    });
    const text = `${mature.lead} ${mature.body}`;
    expect(text).toContain("Share-class tokens, held in your own wallet.");
    expect(text).toContain("They are bearer instruments: whoever controls the wallet can transfer them.");
    expect(text).toContain("offering document");
    expect(text).toContain(
      "Conversion into company shares is not available on Solana mainnet yet; once it is, it will be possible only where the issuer offers it, and will require identity verification (KYC).",
    );
    expect(text).toContain("Each issuer can raise at most EUR 3,000,000 through Manci over any 12 months.");
    expect(text).not.toMatch(/real equity|not a token|SAFE|\$/);
    const offered = whatYouAreBuying({ isStartup: false, structure: null, conversionAvailable: true, network: "mainnet" });
    expect(offered.body).toContain(
      "Conversion into company shares is possible only where the issuer offers it, and requires identity verification (KYC).",
    );
    // A Startup raise (off on mainnet) keeps its SAFE wording, in EUR.
    const startup = whatYouAreBuying({ isStartup: true, structure: "SAFE", conversionAvailable: false, network: "devnet" });
    expect(`${startup.lead} ${startup.body}`).toContain("SAFE agreement");
    expect(startup.body).toContain("EUR 3,000,000");
    expect(startup.body).not.toContain("$");
    expect(RAISE_LIMIT_NOTE).toBe("Issuer limit: EUR 3,000,000 over any 12 months");
    expect(equityOfferedNote(false)).not.toMatch(/ownership/i);
    const page = readFileSync(join(process.cwd(), "app/marketplace/launchpad/[sale]/page.tsx"), "utf8");
    expect(page).toContain("whatYouAreBuying({");
    expect(page).not.toMatch(/\$3M|not a token|Annual equity sale|Actual company ownership/);
  });

  it("/about names switched-off modules as built, not shipped", async () => {
    modulesOff();
    expect(modulesFact("mainnet")).toBe(
      "Launchpad live; OTC settlement, conversion into company shares, governance and vesting built, not available on Solana mainnet",
    );
    expect(modulesFact("devnet")).toBe(
      "Launchpad, OTC settlement, conversion into company shares, governance and vesting shipped",
    );
    vi.stubEnv("NEXT_PUBLIC_FEATURE_SECONDARY_TRADING", "true");
    expect(modulesFact("mainnet")).toBe(
      "Launchpad and OTC settlement live; conversion into company shares, governance and vesting built, not available on Solana mainnet",
    );
    vi.stubEnv("NEXT_PUBLIC_FEATURE_CUSTODY_CONVERSION", "true");
    expect(modulesFact("mainnet")).toBe(
      "Launchpad, OTC settlement and conversion into company shares live; governance and vesting built, not available on Solana mainnet",
    );
    modulesOff();
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    vi.resetModules();
    const { default: AboutPage } = await import("@/app/(marketing)/about/page");
    const text = visibleText(renderToStaticMarkup(createElement(AboutPage)));
    expect(text).toContain(
      "Launchpad live; OTC settlement, conversion into company shares, governance and vesting built, not available on Solana mainnet",
    );
    expect(text).not.toContain("governance and vesting shipped");
  });

  it("instrument and verification copy claims no trading, conversion, distribution or delivery that is switched off", () => {
    const copy = [...strings(ASSET_TYPES), ...strings(INSTRUMENT_LIST)];
    expect(copy.length).toBeGreaterThan(100);
    for (const line of copy) {
      if (/resell board|OTC escrow/.test(line) && /post on|settle through/.test(line)) {
        expect(line).toMatch(/where trading through Manci is available/);
      }
      if (/(convert|shareholders?)\b.*at a time (they|of their|of your)/i.test(line)) {
        expect(line, line).toMatch(/where the issuer offers conversion and it is available/i);
      }
      expect(line).not.toMatch(/^Trade freely|^Request delivery|^When a payout is due/);
    }
    const verification = readFileSync(join(process.cwd(), "components/account-verification.tsx"), "utf8");
    expect(verification).not.toContain("You can convert tokens into company shares and take delivery of physical goods.");
    expect(verification).toContain("where these are available");
    const passportEmail = readFileSync(join(process.cwd(), "app/api/clients/passport-sync/route.ts"), "utf8");
    expect(passportEmail).not.toMatch(/are available from your portfolio/);
    expect(passportEmail).toContain(
      "Where conversion into company shares or delivery of physical goods is available, you can request it from your portfolio",
    );
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
