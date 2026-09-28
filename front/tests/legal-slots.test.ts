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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { assertBuildMainnetLegal } from "@/next.config";
import { OperatorContactDetails } from "@/components/legal/operator-details";
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
  operatorSentence,
  type Operator,
} from "@/lib/legal/operator";
import {
  MAINNET_LEGAL_SLOTS,
  MAINNET_LICENSE_WAIVER,
  mainnetLegalProblems,
  type MainnetLegalSlots,
} from "@/lib/legal/readiness";
import { MAINNET_TERMS } from "@/lib/legal/mainnet-copy";
import { PURCHASE_RISK_WARNING, NO_INVESTOR_PROTECTION } from "@/lib/legal/risk-warning";
import {
  SECURITY_AUDIT,
  securityAuditReport,
  securityReviewFact,
  securityReviewStatement,
} from "@/lib/legal/audit";
import {
  DEVNET_TOS_VERSION,
  MAINNET_TOS_UNPUBLISHED,
  tosVersionFor,
} from "@/lib/tos-version";

const BUILD = "phase-production-build";
const DEV = "phase-development-server";

const COMPANY: Operator = {
  brand: "Manci",
  legalName: "Manci d.o.o. Beograd",
  shortName: "Manci d.o.o.",
  registeredOffice: "Knez Mihailova 1, 11000 Belgrade, Serbia",
  registrationNumber: "21000000",
  taxId: "110000000",
  register: { name: "Serbian Business Registers Agency (APR)", url: null },
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
    const empty = operatorProblems(OPERATORS.mainnet);
    for (const field of ["legalName", "shortName", "registeredOffice", "registrationNumber (MB)", "taxId (PIB)", "register.name", "governingLaw", "disputeResolution"]) {
      expect(empty.join("\n"), field).toContain(field);
    }
  });

  it("refuses drafting leftovers, bad emails, a pilot notice and an incomplete licence", () => {
    expect(operatorProblems({ ...COMPANY, taxId: "TBD" })).toEqual(["operator.taxId (PIB) is not set"]);
    expect(operatorProblems({ ...COMPANY, registeredOffice: "  " })).toEqual(["operator.registeredOffice (sedište) is not set"]);
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
    expect(mainnetLegalProblems({}, { ...READY, riskWarning: PURCHASE_RISK_WARNING })).toEqual([
      expect.stringMatching(/^Purchase risk warning: still engineering's draft/),
    ]);
  });

  it("mainnet legal slots report (what a mainnet build refuses today)", () => {
    const problems = mainnetLegalProblems({}, MAINNET_LEGAL_SLOTS);
    console.info(
      problems.length === 0
        ? "[legal slots] complete: a mainnet build is not refused by lib/legal/"
        : `[legal slots] a mainnet build is refused until:\n  - ${problems.join("\n  - ")}`,
    );
    // Today: no company, no licence, no counsel texts, draft risk warning.
    expect(problems.every((p) => typeof p === "string" && p.length > 0)).toBe(true);
  });
});

describe("assertBuildMainnetLegal (next.config.ts)", () => {
  it("refuses a mainnet production build with the slots committed today and lists what is missing", () => {
    let message = "";
    try {
      assertBuildMainnetLegal(BUILD, { NEXT_PUBLIC_NETWORK: "mainnet", MAINNET_LEGAL_COPY_APPROVED: "true" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/^Refusing a mainnet build: the operator and legal slots are not complete/);
    expect(message).toContain("operator.legalName (full registered name) is not set");
    expect(message).toContain("Terms of Service: counsel's mainnet text has not been added");
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
  it("keeps the devnet version and takes counsel's version on mainnet", () => {
    expect(DEVNET_TOS_VERSION).toBe("2026-07-18");
    for (const network of ["devnet", "testnet", "localnet"] as const) {
      expect(tosVersionFor(network)).toBe(DEVNET_TOS_VERSION);
    }
    expect(tosVersionFor("mainnet")).toBe(MAINNET_TERMS?.version ?? MAINNET_TOS_UNPUBLISHED);
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
