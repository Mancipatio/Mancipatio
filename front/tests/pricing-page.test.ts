// The public /pricing page and the quote surfaces (migration 0089). While
// nothing is published, /pricing is the launch-phase page word for word;
// with published fees it is the price list (who pays, how much, when it is
// invoiced) and the pass-through of third-party costs; when the schedule
// cannot be read it claims nothing either way. A fee whose service this
// build does not offer reads "where offered". FeeQuote renders nothing until
// a fee of its kind is published. Runs in both vitest projects
// (vitest.config.ts KYC_ONLY_OPEN_SUITES): the price list stays readable in
// KYC-only mode.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type AnchorHTMLAttributes, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/link", () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => createElement("a", props),
}));
const h = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/server/fee-schedule", () => ({ loadPublishedFees: h.load }));

import PricingPage, { generateMetadata } from "@/app/(marketing)/pricing/page";
import { FeeQuoteView, type FeeQuoteState } from "@/components/fee-quote";
import { KYC_ONLY_ENV, PILOT_MODULE_ENV } from "@/lib/features";
import type { PublicFee } from "@/lib/fees/schedule";

const html = (element: ReactElement | null) => (element ? renderToStaticMarkup(element) : "");
const text = (markup: string) =>
  markup.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const page = async () => html(await PricingPage());
const cells = (markup: string) =>
  [...markup.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) => [...row[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((cell) => text(cell[1])));

const setup: PublicFee = {
  kind: "tokenization_setup", payer: "issuer", fixed_eur: 2500, rate_bps: 0, min_eur: null, max_eur: null, collection: "invoice",
  public_label: "Tokenization setup", public_note: "One-off, per issuance.", effective_from: "2026-11-01T00:00:00+00:00",
};
const conversion: PublicFee = {
  kind: "conversion", payer: "holder", fixed_eur: 0, rate_bps: 100, min_eur: 150, max_eur: null, collection: "invoice",
  public_label: "Conversion into registered ownership", public_note: "Notary and business-register costs are passed through at cost.",
  effective_from: "2026-11-01T00:00:00+00:00",
};

/** Today's mainnet: KYC-only mode on (the variable unset), every module switch unset. */
function mainnet(kycOnly = "") {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
  vi.stubEnv(KYC_ONLY_ENV, kycOnly);
  for (const variable of Object.values(PILOT_MODULE_ENV)) vi.stubEnv(variable, "");
}

beforeEach(() => {
  h.load.mockReset();
  mainnet();
});
afterEach(() => vi.unstubAllEnvs());

describe("/pricing before any fee is published", () => {
  it("is the launch-phase page word for word, metadata included", async () => {
    h.load.mockResolvedValue([]);
    const visible = text(await page());
    const intro =
      "Pricing No platform fees during the launch phase. " +
      "We're not charging issuers or holders while we onboard our first cohort. When we introduce platform fees, existing issuers will be told before anything changes. " +
      "What is not ours SPV incorporation, legal drafting and regulatory filings are real third-party costs. They’re quoted per engagement before any work starts. Nothing is charged on-chain. " +
      "What an engagement covers Structuring Legal and commercial structuring of the instrument, shaped to your deal. " +
      "SPV incorporation Where Serbian law requires one, incorporated and administered for the issuance. " +
      "Tokenisation Token design, on-chain issuance, and the compliance rails. " +
      "Whitepaper Drafting and publication of the whitepaper or basic token information. " +
      "Distribution rails ";
    expect(visible.startsWith(intro)).toBe(true);
    // The last card follows the build's OTC scope (read when the page module loads), as before.
    expect(["The approved primary sale and allocation process.", "Primary sales and secondary trading through OTC escrow."])
      .toContain(visible.slice(intro.length));
    expect(await generateMetadata()).toEqual({
      title: "Pricing — Manci",
      description: "No platform fees during the launch phase. SPV incorporation, legal drafting and regulatory filings are third-party costs, quoted per engagement before any work starts.",
    });
  });

  it("keeps the Apply button where KYC-only mode is off", async () => {
    h.load.mockResolvedValue([]);
    mainnet("off");
    expect(await page()).toContain('href="/apply"');
  });
});

describe("/pricing with published fees", () => {
  it("lists who pays, how much and when it is invoiced, with third-party costs at cost", async () => {
    h.load.mockResolvedValue([setup, conversion]);
    const markup = await page();
    const visible = text(markup);
    expect(visible).not.toContain("No platform fees");
    expect(visible).toContain("What Manci charges.");
    expect(cells(markup)).toEqual([
      ["Service", "Who pays", "How much", "When it is invoiced"],
      // KYC-only mainnet offers neither service: both read "where offered".
      ["Tokenization setup (where offered)", "Issuer", "EUR 2,500", "When the application is approved"],
      ["Conversion into registered ownership (where offered)", "Holder", "1 % of the conversion value, minimum EUR 150", "When the conversion request is approved"],
    ]);
    expect(visible).toContain("Tokenization setup: One-off, per issuance.");
    expect(visible).toContain("Conversion into registered ownership: Notary and business-register costs are passed through at cost.");
    expect(visible).toContain(
      "Third-party costs (legal drafting, SPV incorporation, notary, business register) are passed through at cost and quoted before work starts.",
    );
    expect(visible).toContain("Fees are invoiced in euros; nothing is charged on-chain.");
    expect(visible).toContain("A fee applies only where its service is offered.");
    expect((await generateMetadata()).description).toBe(
      "Manci's published fees: what each service costs, who pays and when it is invoiced. Third-party costs are passed through at cost and quoted before work starts.",
    );
  });

  it("drops 'where offered' for a service this build offers", async () => {
    h.load.mockResolvedValue([setup, conversion]);
    mainnet("off");
    expect(cells(await page()).map((row) => row[0])).toEqual([
      "Service", "Tokenization setup", "Conversion into registered ownership (where offered)",
    ]);
    vi.stubEnv(PILOT_MODULE_ENV.custodyConversion, "true");
    expect(cells(await page())[2][0]).toBe("Conversion into registered ownership");
  });

  it("shows when an announced price applies, and keeps two equal labels apart", async () => {
    h.load.mockResolvedValue([setup, { ...conversion, public_label: "Tokenization setup", effective_from: "2099-01-01T00:00:00+00:00" }]);
    mainnet("off");
    expect(cells(await page())).toEqual([
      ["Service", "Who pays", "How much", "When it is invoiced", "Applies from"],
      ["Tokenization setup", "Issuer", "EUR 2,500", "When the application is approved", "In effect"],
      ["Tokenization setup (Conversion) (where offered)", "Holder", "1 % of the conversion value, minimum EUR 150", "When the conversion request is approved", "1 January 2099"],
    ]);
  });
});

describe("/pricing when the schedule cannot be read", () => {
  it("claims nothing about fees and offers the contact page", async () => {
    h.load.mockRejectedValue(new Error("database down"));
    const markup = await page();
    const visible = text(markup);
    expect(visible).toContain("The fee schedule could not be loaded right now.");
    expect(markup).toContain('href="/contact"');
    expect(visible).not.toContain("No platform fees");
    expect(visible).not.toContain("What Manci charges");
    expect(markup).not.toContain("<table");
    const metadata = await generateMetadata();
    expect(metadata.description).not.toMatch(/No platform fees/);
  });
});

describe("FeeQuote", () => {
  const view = (state: FeeQuoteState, extra: { baseEur?: number; quantity?: number } = {}) =>
    html(createElement(FeeQuoteView, { kind: "conversion", state, ...extra }));
  const ready = (fees: PublicFee[]): FeeQuoteState => ({ phase: "ready", fees, checkedAt: Date.parse("2026-11-08T12:00:00Z") });

  it("renders nothing while loading and while no fee of its kind is published", () => {
    expect(view({ phase: "loading" })).toBe("");
    expect(view(ready([]))).toBe("");
    expect(view(ready([setup]))).toBe("");
  });

  it("shows the published fee the way /pricing words it", () => {
    const visible = text(view(ready([setup, conversion])));
    expect(visible).toBe(
      "Manci fee: 1 % of the conversion value, minimum EUR 150. " +
      "Paid by the holder, invoiced in euros when the conversion request is approved; nothing is charged on-chain. " +
      "Notary and business-register costs are passed through at cost. Pricing",
    );
    expect(text(view(ready([conversion]), { baseEur: 10_000 }))).toContain("Estimated fee: EUR 150.");
    expect(text(view(ready([conversion]), { baseEur: 50_000 }))).toContain("Estimated fee: EUR 500.");
    expect(text(view(ready([{ ...conversion, effective_from: "2099-01-01T00:00:00Z" }])))).toContain("(from 1 January 2099)");
  });

  it("says when the fee could not be loaded instead of staying silent", () => {
    const markup = view({ phase: "failed" });
    expect(text(markup)).toBe("The published fee for this step could not be loaded. See pricing before you continue.");
    expect(markup).toContain('href="/pricing"');
  });

  it("sits next to the conversion request and the /apply review, one line each", () => {
    const conversionPage = readFileSync(join(process.cwd(), "app/portfolio/conversion/page.tsx"), "utf8");
    const applyPage = readFileSync(join(process.cwd(), "app/(marketing)/apply/page.tsx"), "utf8");
    expect(conversionPage.match(/<FeeQuote\b[^>]*\/>/g)).toEqual(['<FeeQuote kind="conversion" />']);
    expect(applyPage.match(/<FeeQuote\b[^>]*\/>/g)).toEqual(['<FeeQuote kind="tokenization_setup" className="mt-5" />']);
    // Before the request's submit button and in the review step.
    expect(conversionPage.indexOf("<FeeQuote")).toBeLessThan(conversionPage.indexOf("Submit request"));
    expect(applyPage.indexOf("<FeeQuote")).toBeGreaterThan(applyPage.indexOf("Review your application"));
  });
});
