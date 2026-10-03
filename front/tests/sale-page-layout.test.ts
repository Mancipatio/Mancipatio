// The launchpad sale page after the owner's feedback of 2026-10-03 ("the
// documents beside, the purchase at the top"): the buy card comes first in
// the DOM (the phone order; a sticky right column on a wide screen), the two
// acceptances sit directly above the button with links to the full texts, the
// full documents and risk warning sit above the tabs, a tokenized class says
// "Buy tokens" / "Sold", and empty pitch sections are hidden. Rendered to
// static markup (no jsdom); the page source is read for the wiring.
import fs from "node:fs";
import path from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SaleAcceptances,
  SaleDocumentsSection,
  SalePageLayout,
  SaleRiskWarningSection,
  SoldProgress,
} from "@/components/launchpad/sale-sections";
import { SaleOverview } from "@/components/launchpad/sale-overview";
import type { SaleDocumentTerms } from "@/lib/document-terms";
import type { LaunchListing, PublicApplication } from "@/lib/launchpad";
import { PURCHASE_RISK_WARNING } from "@/lib/legal/risk-warning";
import {
  KYC_GATED_TOKENS_NOTE,
  SALE_DOCUMENTS_ANCHOR,
  SALE_RISK_WARNING_ANCHOR,
  buyCardTitle,
  companyOfTokenizedName,
  purchaseAcceptanceComplete,
  saleKind,
  saleTermsFootnote,
  soldProgress,
  tokenSummaryLines,
} from "@/lib/sale-page";
import { OPEN_TOKENS_NOTE } from "@/lib/tokenize-shares";
import { SSC_NOT_APPROVED_LABEL } from "@/lib/whitepaper-approval";

const html = (node: ReactNode) => renderToStaticMarkup(node as never);
const esc = (text: string) => text.replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
const SALE = "Sa1e111111111111111111111111111111111111111";
const TERMS = {
  sale: SALE,
  url: "https://docs.example.test/whitepaper.pdf",
  sha256: "ab".repeat(32),
  versionId: "v-1",
  sscDecisionRef: null,
} as unknown as SaleDocumentTerms;
const noop = () => undefined;

function acceptances(props: Partial<Parameters<typeof SaleAcceptances>[0]> = {}) {
  return createElement(SaleAcceptances, {
    terms: TERMS,
    error: null,
    acceptedTerms: false,
    onAcceptedTermsChange: noop,
    acceptedRisk: false,
    onAcceptedRiskChange: noop,
    ...props,
  });
}

describe("layout: the buy card first, the documents beside it", () => {
  const markup = html(
    createElement(SalePageLayout, {
      header: createElement("h1", null, "HERC · 10 %"),
      buy: createElement("div", { "data-sale-buy-card": "" }, acceptances(), createElement("button", null, "Buy")),
      main: createElement(
        "div",
        null,
        createElement(SaleDocumentsSection, { terms: TERMS, error: null }),
        createElement(SaleRiskWarningSection),
      ),
    }),
  );

  it("renders header → buy card → main column in DOM order (the phone order)", () => {
    const header = markup.indexOf('data-sale-region="header"');
    const buy = markup.indexOf('data-sale-region="buy"');
    const main = markup.indexOf('data-sale-region="main"');
    expect(header).toBeGreaterThanOrEqual(0);
    expect(buy).toBeGreaterThan(header);
    expect(main).toBeGreaterThan(buy);
    // The buy card (with its acceptances) comes before the full documents and the risk warning.
    expect(markup.indexOf("data-sale-buy-card")).toBeLessThan(markup.indexOf(`id="${SALE_DOCUMENTS_ANCHOR}"`));
    expect(markup.indexOf(`id="${SALE_DOCUMENTS_ANCHOR}"`)).toBeLessThan(markup.indexOf(`id="${SALE_RISK_WARNING_ANCHOR}"`));
  });

  it("puts the buy card in a sticky right column on a wide screen, beside header and main", () => {
    const aside = markup.slice(markup.indexOf("<aside"), markup.indexOf(">", markup.indexOf("<aside")));
    expect(aside).toContain("lg:sticky");
    expect(aside).toContain("lg:col-start-2");
    expect(aside).toContain("lg:row-span-2");
    expect(markup).toContain("lg:grid-cols-[minmax(0,1fr)_360px]");
  });

  it("the right column holds no document block or warning text: only the acceptances", () => {
    const aside = markup.slice(markup.indexOf("<aside"), markup.indexOf("</aside>"));
    expect(aside).not.toContain(`id="${SALE_DOCUMENTS_ANCHOR}"`);
    expect(aside).not.toContain(esc(PURCHASE_RISK_WARNING.points[0]));
    expect(aside).toContain("data-sale-acceptances");
  });
});

describe("the legal blocks", () => {
  it("the documents block keeps the status line, the verified link and the fingerprint, and no checkbox", () => {
    const markup = html(createElement(SaleDocumentsSection, { terms: TERMS, error: null }));
    expect(markup).toContain("Investment documents");
    expect(markup).toContain(SSC_NOT_APPROVED_LABEL);
    expect(markup).toContain("Read the document (fingerprint verified) ↗");
    expect(markup).toContain(`href="${TERMS.url}"`);
    expect(markup).toContain(`SHA-256: ${TERMS.sha256}`);
    expect(markup).not.toContain('type="checkbox"');
  });

  it("an approved document shows the decision reference", () => {
    const markup = html(createElement(SaleDocumentsSection, { terms: { ...TERMS, sscDecisionRef: "SSC-42" }, error: null }));
    expect(markup).toContain("Approved by the Serbian Securities Commission · SSC-42");
  });

  it("without terms for this sale: the error, or that they load", () => {
    expect(html(createElement(SaleDocumentsSection, { terms: null, error: "Unavailable" }))).toContain("Unavailable");
    expect(html(createElement(SaleDocumentsSection, { terms: null, error: null }))).toContain("Loading the verified document…");
  });

  it("the risk warning section carries every point, unchanged, and no checkbox", () => {
    const markup = html(createElement(SaleRiskWarningSection));
    for (const point of PURCHASE_RISK_WARNING.points) expect(markup).toContain(esc(point));
    expect(markup).not.toContain('type="checkbox"');
  });
});

describe("the acceptances above the Buy button", () => {
  it("carry both checkboxes with the legal wording unchanged, unticked, each with a read link", () => {
    const markup = html(acceptances());
    expect(markup.match(/type="checkbox"/g)).toHaveLength(2);
    expect(markup).not.toContain("checked");
    expect(markup).toContain(
      esc(`I have read and accept this document version and its stated risks and rights. Status: ${SSC_NOT_APPROVED_LABEL}.`),
    );
    expect(markup).toContain(esc(PURCHASE_RISK_WARNING.acknowledgement));
    expect(markup).toContain(`href="${TERMS.url}"`);
    expect(markup).toContain(`href="#${SALE_RISK_WARNING_ANCHOR}"`);
    expect(markup).toContain("Read the risk warning");
    // The document checkbox comes first, the risk warning second.
    expect(markup.indexOf("I have read and accept")).toBeLessThan(markup.indexOf(esc(PURCHASE_RISK_WARNING.acknowledgement)));
  });

  it("show the approval reference in the document acceptance when there is one", () => {
    const markup = html(acceptances({ terms: { ...TERMS, sscDecisionRef: "SSC-42" } }));
    expect(markup).toContain("Status: approved by the Serbian Securities Commission (SSC-42).");
  });

  it("without terms there is nothing to accept: the reason instead of the boxes", () => {
    const markup = html(acceptances({ terms: null, error: "Verified investment documents are unavailable" }));
    expect(markup).not.toContain('type="checkbox"');
    expect(markup).toContain("Verified investment documents are unavailable");
  });

  it("a purchase still needs this sale's document version AND the risk warning", () => {
    const base = { salePubkey: SALE, documentSale: SALE, acceptedTerms: true, acceptedRisk: true };
    expect(purchaseAcceptanceComplete(base)).toBe(true);
    expect(purchaseAcceptanceComplete({ ...base, acceptedTerms: false })).toBe(false);
    expect(purchaseAcceptanceComplete({ ...base, acceptedRisk: false })).toBe(false);
    expect(purchaseAcceptanceComplete({ ...base, documentSale: "Other111111111111111111111111111111111111111" })).toBe(false);
    expect(purchaseAcceptanceComplete({ ...base, documentSale: null })).toBe(false);
  });
});

describe("the page wiring (source)", () => {
  const page = fs.readFileSync(path.join(__dirname, "../app/marketplace/launchpad/[sale]/page.tsx"), "utf8");

  it("the Buy button waits for the acceptances, and both send paths check them again", () => {
    expect(page).toMatch(/const canCommit =[\s\S]*?acceptanceComplete &&[\s\S]*?;/);
    expect(page.match(/if \(!acceptedTerms \|\| !acceptedRisk \|\| documentTerms\?\.sale !== salePubkey\)/g)).toHaveLength(2);
    // The server-side checks are unchanged: the sanctions screen (with the Terms link) before the buy.
    expect(page).toContain("await screenOwnWallet(conn.wallet);");
  });

  it("renders the acceptances before the button inside the buy card, and the documents above the tabs", () => {
    const buy = page.indexOf("const buy = (");
    const main = page.indexOf("const main = (");
    expect(buy).toBeGreaterThan(0);
    expect(main).toBeGreaterThan(buy);
    const card = page.slice(buy, main);
    expect(card.indexOf("<SaleAcceptances")).toBeLessThan(card.indexOf("{/* Commit / Buy button */}"));
    expect(card).not.toContain("<SaleDocumentsSection");
    // The full documents and risk warning sit above the tab bar, outside any
    // `activeTab === …` branch, so every tab shows them.
    const mainColumn = page.slice(main);
    const tabBar = mainColumn.indexOf("{/* Tab bar */}");
    expect(tabBar).toBeGreaterThan(0);
    expect(mainColumn.slice(0, tabBar)).toMatch(/<SaleDocumentsSection[\s\S]*?<SaleRiskWarningSection/);
    expect(mainColumn.slice(0, tabBar)).not.toContain("activeTab");
    expect(page.match(/<SaleDocumentsSection /g)).toHaveLength(1);
    expect(page.match(/<SaleRiskWarningSection /g)).toHaveLength(1);
    expect(page).toContain("<SalePageLayout header={header} buy={buy} main={main} />");
  });

  it("gives a tokenized class's Deal terms the mainnet Terms wording (lib/deal-terms-copy)", () => {
    const terms = page.slice(page.indexOf("function TermsTab("));
    const tokenizedBranch = terms.slice(terms.indexOf("if (tokenized) {"), terms.indexOf("type TermRow"));
    expect(terms.indexOf("whatYouAreBuying({")).toBeLessThan(terms.indexOf("if (tokenized) {"));
    expect(tokenizedBranch).toContain("{buying.lead}</strong> {buying.body}");
  });

  it("no longer labels payment units as tokens, nor shows empty terms", () => {
    expect(page).not.toContain("Verified payments · payment token units");
    expect(page).not.toMatch(/Min ticket: \{app\?\.min_ticket \?\? "—"\}/);
    expect(page).toContain("{buyCardTitle(kind)}");
  });
});

describe("copy for a tokenized share class", () => {
  it("is a tokenized class only for an on-chain sale with the tokenize figures", () => {
    expect(saleKind({ settlesOnChain: true, tokenPercentE4: BigInt(10) })).toBe("tokenized");
    expect(saleKind({ settlesOnChain: true, tokenPercentE4: null })).toBe("mature");
    expect(saleKind({ settlesOnChain: false, tokenPercentE4: BigInt(10) })).toBe("startup");
  });

  it("buys tokens, not shares; a Startup raise keeps its wording", () => {
    expect(buyCardTitle("tokenized")).toBe("Buy tokens");
    expect(buyCardTitle("mature")).toBe("Buy shares");
    expect(buyCardTitle("startup")).toBe("Back this company");
  });

  it("shows progress as Sold tokens of the tokens for sale", () => {
    expect(soldProgress(BigInt(3000), BigInt(30000))).toEqual({ sold: "3,000", total: "30,000", percent: 10 });
    expect(soldProgress(BigInt(0), BigInt(0)).percent).toBe(0);
    const markup = html(
      createElement(SoldProgress, { sold: BigInt(0), total: BigInt(30000), buyers: 0, daysLeft: 88, verifiedPayments: "0 USDC" }),
    );
    expect(markup).toContain(">Sold<");
    expect(markup).toContain("0 / 30,000");
    expect(markup).toContain("0% sold");
    expect(markup).toContain("Days left");
    expect(markup).toContain("88");
    expect(markup).not.toContain("payment token units");
  });

  it("hides Min ticket and Structure when the sale has none", () => {
    expect(saleTermsFootnote({ minTicket: null, structure: null })).toBeNull();
    expect(saleTermsFootnote({ minTicket: "  ", structure: undefined })).toBeNull();
    expect(saleTermsFootnote({ minTicket: "$1,000", structure: null })).toBe("Min ticket: $1,000");
    expect(saleTermsFootnote({ minTicket: "$1,000", structure: "SAFE" })).toBe("Min ticket: $1,000 · Structure: SAFE");
  });

  it("names the company of a tokenized listing name", () => {
    expect(companyOfTokenizedName("HERC · 10 %")).toBe("HERC");
    expect(companyOfTokenizedName("Acme d.o.o. · 0.5 %")).toBe("Acme d.o.o.");
    expect(companyOfTokenizedName("Plain name")).toBe("Plain name");
  });

  it("summarises the tokens: the profile's own summary, one token's share, and gating when it applies", () => {
    const profileSummary = `10,000 tokens = 10 % of HERC (Serbia). ${OPEN_TOKENS_NOTE}`;
    expect(
      tokenSummaryLines({ company: "HERC", profileSummary, capTokens: BigInt(10000), tokenPercentE4: BigInt(10), restriction: "open" }),
    ).toEqual([profileSummary, "1 token = 0.001 % of HERC."]);
    // No profile summary: the same sentence from the class cap; the open note only for an Open class.
    expect(
      tokenSummaryLines({ company: "HERC", profileSummary: null, capTokens: BigInt(10000), tokenPercentE4: BigInt(10), restriction: "open" }),
    ).toEqual([`10,000 tokens = 10 % of HERC. ${OPEN_TOKENS_NOTE}`, "1 token = 0.001 % of HERC."]);
    expect(
      tokenSummaryLines({ company: "HERC", profileSummary: "", capTokens: BigInt(10000), tokenPercentE4: BigInt(10), restriction: "kyc-gated" }),
    ).toEqual(["10,000 tokens = 10 % of HERC.", "1 token = 0.001 % of HERC.", KYC_GATED_TOKENS_NOTE]);
    // Without the tokenize figures there is no summary.
    expect(tokenSummaryLines({ company: "HERC", profileSummary, capTokens: BigInt(10000), tokenPercentE4: null, restriction: "open" })).toEqual([]);
  });
});

describe("the Overview hides empty sections", () => {
  const empty = createElement(SaleOverview, {
    listing: null,
    app: null,
    company: "HERC",
    tokenSummary: ["10,000 tokens = 10 % of HERC.", "1 token = 0.001 % of HERC."],
  });

  it("shows no empty 'The problem' / 'Why now', and the token summary instead", () => {
    const markup = html(empty);
    expect(markup).not.toContain("The problem");
    expect(markup).not.toContain("Why now");
    expect(markup).not.toContain(">—<");
    expect(markup).toContain("The tokens");
    expect(markup).toContain("1 token = 0.001 % of HERC.");
  });

  it("keeps a section that has something to say", () => {
    const listing = { problem: "Paper cap tables.", why_now: null, traction: {}, existing_investors: null } as unknown as LaunchListing;
    const markup = html(createElement(SaleOverview, { listing, app: null as PublicApplication | null, company: "HERC" }));
    expect(markup).toContain("The problem");
    expect(markup).toContain("Paper cap tables.");
    expect(markup).not.toContain("Why now");
    expect(markup).not.toContain("The tokens");
  });

  it("shows the profile's description when the application says nothing", () => {
    const markup = html(createElement(SaleOverview, { listing: null, app: null, company: "HERC", about: "Facility services." }));
    expect(markup).toContain("About HERC");
    expect(markup).toContain("Facility services.");
  });
});
