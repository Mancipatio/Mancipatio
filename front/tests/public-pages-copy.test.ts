// Public marketing pages before the site opens to the public: their copy
// must match the live setup (tokenization, issuers' direct transfers and
// primary sales the operator approves) and stay true before and after
// trading through Manci and conversion are switched on (lib/features.ts).
// No page states a structure every issuance uses (a Serbian SPV, a share
// pledge), implies a regulator's approval that is not recorded, promises a
// launch phase or a cohort, or still reads like the devnet pilot.
//
// Pages are rendered as the mainnet build would render them, with every
// module switch off (the live state) and, where a page follows a switch,
// with it on.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The documentation pages sit in the app shell, which needs the Next router;
// the page body is what is checked here.
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/documentation-frame", () => ({
  DocumentationFrame: ({ children }: { children: ReactNode }) => children,
}));

const MODULE_VARS = [
  "SECONDARY_TRADING",
  "GOVERNANCE",
  "VESTING",
  "RIGHTS",
  "DISTRIBUTIONS",
  "CUSTODY_CONVERSION",
  "CUSTODY_DELIVERY",
];

const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

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

/** The page's markup and visible text, as this build's network renders it. */
async function render(modulePath: string): Promise<{ html: string; text: string }> {
  vi.resetModules();
  const { default: Page } = (await import(modulePath)) as { default: ComponentType };
  const html = renderToStaticMarkup(createElement(Page));
  return { html, text: visibleText(html) };
}

const PAGES = {
  risks: "@/app/(marketing)/risks/page",
  legalStructure: "@/app/(marketing)/legal-structure/page",
  pricing: "@/app/(marketing)/pricing/page",
  about: "@/app/(marketing)/about/page",
  faq: "@/app/(marketing)/faq/page",
  security: "@/app/(marketing)/security/page",
  investors: "@/app/(marketing)/investors/page",
  recovery: "@/app/docs/recovery/page",
} as const;

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
  for (const name of MODULE_VARS) vi.stubEnv(`NEXT_PUBLIC_FEATURE_${name}`, "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("public pages on mainnet, every module switched off (the live state)", () => {
  it("say nothing that only holds for the devnet pilot, a launch phase or a first cohort", async () => {
    for (const [name, path] of Object.entries(PAGES)) {
      const { text } = await render(path);
      expect(text, name).not.toMatch(/\bpilot\b/i);
      expect(text, name).not.toMatch(/test assets|test release/i);
      expect(text, name).not.toMatch(/launch phase|first cohort|first offering opens|join the list/i);
      expect(text, name).not.toMatch(/first in the world|world'?s first/i);
    }
  });

  it("present no Serbian SPV or regulator approval as part of every issuance", async () => {
    for (const path of [PAGES.risks, PAGES.legalStructure, PAGES.pricing, PAGES.about]) {
      const { text } = await render(path);
      expect(text, path).not.toMatch(/\bSPV\b|Serbian/);
      expect(text, path).not.toMatch(/Securities Commission/);
      expect(text, path).not.toMatch(/incorporate[sd]? (one|it|the company) for you|for you if you don'?t/i);
    }
  });

  it("/risks: regulatory position and raise limit as the Terms state them, trading and conversion only where available", async () => {
    const { text } = await render(PAGES.risks);
    expect(text).toContain("Each issuer is responsible for the licences, approvals and consents its offering requires.");
    expect(text).toContain(
      "A whitepaper is shown as approved by a regulator only where the approval and its decision reference are recorded; otherwise it has not been approved.",
    );
    expect(text).toContain("at most EUR 3,000,000 over any twelve months");
    expect(text).toContain("Where an issuer issues through a special purpose vehicle, the limit applies to that vehicle.");
    expect(text).toContain("Where trading through Manci is available, holders can post what they hold on the resell board");
    expect(text).toContain("Where trading through Manci is available, an OTC deal cannot expire");
    expect(text).toContain("Conversion into shares is possible only where the issuer offers conversion and it is available.");
    expect(text).not.toMatch(/capped at EUR 3 million per SPV/);
  });

  it("/legal-structure: an SPV or a share pledge is a per-issuance matter, not the rule", async () => {
    const { text, html } = await render(PAGES.legalStructure);
    expect(text).toContain(
      "an issuer bound by the right the token carries, documents that set that right out, and a documented route to enforcement",
    );
    expect(text).toContain("depends on that issuance");
    expect(text).not.toMatch(/share pledge registered in holders' favour where the instrument allows one/);
    // The page's description (search results, link previews) says the same.
    const { metadata } = (await import(PAGES.legalStructure)) as { metadata: { description: string } };
    expect(metadata.description).not.toMatch(/SPV|pledge/);
    expect(html).not.toContain("Serbian");
  });

  it("/pricing: no fee for buyers and holders, issuers per their engagement agreement, no phase or cohort", async () => {
    const { text } = await render(PAGES.pricing);
    expect(text).toContain("No fees for buyers and holders.");
    expect(text).toContain("costs only the Solana network fees of your own transactions");
    expect(text).toContain("Issuers pay what their engagement agreement provides.");
    expect(text).toContain("A fee for buyers or holders would come only with a new version of the Terms");
    expect(text).toContain(
      "a primary sale the operator approves, transfers from your treasury to wallets you choose, and trading through Manci where it is available",
    );
    expect(text).not.toMatch(/not charging issuers|OTC escrow/);
    const { metadata } = (await import(PAGES.pricing)) as { metadata: { description: string } };
    expect(metadata.description).not.toMatch(/launch phase|SPV/);
  });

  it("/about: investors buy in operator-approved sales; the operator's powers are not denied", async () => {
    const { text } = await render(PAGES.about);
    expect(text).toContain("Investors buy in primary sales the operator has approved, with no invitation needed");
    expect(text).not.toContain("rather than entrusted to an operator");
    expect(text).toContain("the operator's own powers over them set out in the Terms");
    expect(text).toContain(
      "Launchpad live; OTC settlement, conversion into company shares, governance and vesting built, not available on Solana mainnet",
    );
  });

  it("/investors names and links OTC offers only while trading through Manci is switched on", async () => {
    const off = await render(PAGES.investors);
    expect(off.text).toContain("Browse assets and open sales.");
    expect(off.text).not.toContain("OTC");
    expect(off.html).not.toContain('href="/marketplace/otc"');
    expect(off.text).toContain("take delivery of a physical good, where these are available");

    vi.stubEnv("NEXT_PUBLIC_FEATURE_SECONDARY_TRADING", "true");
    const on = await render(PAGES.investors);
    expect(on.text).toContain("Browse assets, open sales and funded OTC offers.");
    expect(on.html).toContain('href="/marketplace/otc"');
  });

  it("/faq answers the selling question for both states of trading through Manci", async () => {
    const { text } = await render(PAGES.faq);
    expect(text).toContain("Where trading through Manci is available, you can create an OTC offer or post on the resell board");
    expect(text).toContain("where it is not, those pages say so");
  });

  it("the home page description promises no OTC offers or vesting", async () => {
    const { metadata } = (await import("@/app/page")) as { metadata: { description: string } };
    expect(metadata.description).not.toMatch(/OTC|vesting/);
  });
});

describe("the transaction recovery guide replaces the pilot operator guide", () => {
  it("links from /security, /faq and the documentation index point at /docs/recovery", async () => {
    for (const path of [PAGES.security, PAGES.faq]) {
      const { html } = await render(path);
      expect(html, path).toContain('href="/docs/recovery"');
      expect(html, path).not.toContain("/docs/pilot");
    }
    const { DOCUMENTATION_TOPICS } = await import("@/lib/documentation");
    const hrefs = DOCUMENTATION_TOPICS.map((topic) => topic.href);
    expect(hrefs).toContain("/docs/recovery");
    expect(hrefs).not.toContain("/docs/pilot");
    for (const topic of DOCUMENTATION_TOPICS) {
      expect(`${topic.title} ${topic.description} ${topic.keywords ?? ""}`, topic.href).not.toMatch(/pilot|test release|devnet/i);
    }
  });

  it("/docs/pilot forwards to /docs/recovery", () => {
    const page = src("app/docs/pilot/page.tsx");
    expect(page).toContain('redirect("/docs/recovery")');
    expect(page).not.toMatch(/<[A-Z]/); // no page of its own left behind
  });

  it("carries the sentence the deployment smoke test checks, on the old and the new address alike", async () => {
    const smoke = src("scripts/ops/deployment-smoke.test.ts");
    const checked = /fetch\(origin \+ "\/docs\/pilot"[\s\S]*?toContain\("([^"]+)"\)/.exec(smoke)?.[1];
    expect(checked).toBe("A pending or unavailable status is not proof of failure.");
    const { text } = await render(PAGES.recovery);
    expect(text).toContain(checked);
    expect(text).toContain("Do not create another sale, repeat a deposit or rebuild recipients");
  });
});
