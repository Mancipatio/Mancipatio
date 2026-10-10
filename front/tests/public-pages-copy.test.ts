// Public marketing pages before the site opens to the public: their copy
// must match the live setup (tokenization, issuers' direct transfers and
// primary sales the operator approves) and stay true before and after
// trading through Manci and conversion are switched on (lib/features.ts).
//
// Checked here, page by page:
//  - /risks, /legal-structure, /pricing and /about name no Serbian SPV, no
//    Securities Commission and no incorporation "for you";
//  - the instruments catalog (/markets/types and every fact sheet under it,
//    with the data in lib/instruments.ts and lib/asset-types.tsx) and the
//    /apply issuer flow state an SPV, a share pledge and the raise limit per
//    issuance and as the Terms set them (clause 7), never as the rule;
//  - no page checked here promises a launch phase or a cohort, or still reads
//    like the devnet pilot; switched-off modules are named "where available"
//    or only while their switch is on.
// The whitepaper approval label (Securities Commission) is pinned in
// tests/login-guard-surfaces.test.ts.
//
// Pages are rendered as the mainnet build would render them, with every
// module switch off (the live state) and, where a page follows a switch,
// with it on.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, Fragment, type ComponentType, type ReactNode } from "react";
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
  "STARTUP_RAISES",
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

/** An async page with route params (a server component), rendered the same way. */
async function renderRoute(
  modulePath: string,
  slug: string,
): Promise<{ html: string; text: string; description: string | undefined }> {
  vi.resetModules();
  const mod = (await import(modulePath)) as {
    default: (props: { params: Promise<{ slug: string }> }) => Promise<ReactNode>;
    generateMetadata: (props: { params: Promise<{ slug: string }> }) => Promise<{ description?: string }>;
  };
  const element = await mod.default({ params: Promise.resolve({ slug }) });
  const html = renderToStaticMarkup(createElement(Fragment, null, element));
  const { description } = await mod.generateMetadata({ params: Promise.resolve({ slug }) });
  return { html, text: visibleText(html), description };
}

/** Every string in a value (React elements skipped), as in tests/legal-slots.test.ts. */
const strings = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object" || "$$typeof" in value) return [];
  return Object.values(value).flatMap(strings);
};

/** Wording that states an SPV, its incorporation or free trading as the rule. */
const SPV_AS_RULE =
  /Serbian SPV|issued through an? (Serbian )?SPV|incorporated for you|incorporates? the company|we incorporate one|open the company[^.]*for you|per SPV per year|per year per SPV|EUR 3M per SPV|freely transferable and tradeable/i;

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
    // What the platform knows (whether an approval is on record), not a
    // statement about what the regulator decided.
    expect(text).toContain(
      "A whitepaper is shown as approved by a regulator only where the approval and its decision reference are recorded; otherwise no approval is on record, and the whitepaper is shown as not approved.",
    );
    expect(text).not.toContain("otherwise it has not been approved");
    expect(text).toContain("at most EUR 3,000,000 over any twelve months");
    expect(text).toContain("Where an issuer issues through a special purpose vehicle, the limit applies to that vehicle.");
    expect(text).toContain("Where trading through Manci is available, holders can post what they hold on the resell board");
    expect(text).toContain("Where trading through Manci is available, an OTC deal cannot expire");
    expect(text).toContain("Conversion into shares is possible only where the issuer offers conversion and it is available.");
    // Units are escrowed and burned on-chain; only the share transfer is off-chain.
    expect(text).toContain("the share transfer itself does not happen on-chain");
    expect(text).not.toMatch(/It is not automatic and does not happen on-chain/);
    expect(text).toContain(
      "Where delivery of a physical asset is available, it is arranged with the issuer: Manci does not move the goods",
    );
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

  it("/investors names vesting and startup payout vaults only while their switches are on", async () => {
    const off = await render(PAGES.investors);
    expect(off.html).not.toContain('href="/portfolio/vesting"');
    expect(off.text).not.toContain("Startup payout-vault");
    expect(off.text).toContain("delivery where these are available and relevant to your positions");

    vi.stubEnv("NEXT_PUBLIC_FEATURE_VESTING", "true");
    vi.stubEnv("NEXT_PUBLIC_FEATURE_STARTUP_RAISES", "true");
    const on = await render(PAGES.investors);
    expect(on.html).toContain('href="/portfolio/vesting"');
    expect(on.text).toContain("Startup payout-vault entitlements follow their saved original-investor snapshot");
  });

  it("/faq answers the selling question for both states of trading through Manci", async () => {
    const { text } = await render(PAGES.faq);
    expect(text).toContain("Where trading through Manci is available, you can create an OTC offer or post on the resell board");
    expect(text).toContain("where it is not, those pages say so");
  });

  it("/faq: verification only where conversion or delivery is available; the vesting question only while vesting is on", async () => {
    const off = await render(PAGES.faq);
    expect(off.text).toContain(
      "Verification (KYC) is required when you convert tokens into company shares or take delivery of a physical good, where these are available.",
    );
    expect(off.text).not.toContain("Where do I check my vesting?");
    expect(off.html).not.toContain('href="/portfolio/vesting"');
    const { metadata } = (await import(PAGES.faq)) as { metadata: { description: string } };
    expect(metadata.description).not.toMatch(/vesting/i);

    vi.stubEnv("NEXT_PUBLIC_FEATURE_VESTING", "true");
    const on = await render(PAGES.faq);
    expect(on.text).toContain("Where do I check my vesting?");
  });

  it("/solutions: the launchpad and OTC guides name trading through Manci only where it is available", async () => {
    const launchpad = await renderRoute("@/app/(marketing)/solutions/[slug]/page", "launchpad");
    expect(launchpad.text).toContain("Where trading through Manci is available, existing holders can use the OTC market");
    const otc = await renderRoute("@/app/(marketing)/solutions/[slug]/page", "otc");
    expect(otc.text).toContain("Where trading through Manci is available, create a sell offer");
    expect(otc.description).toMatch(/^Where trading through Manci is available/);
  });

  it("/docs/recovery names vesting and distributions only where they are available", async () => {
    const { text } = await render(PAGES.recovery);
    expect(text).toContain("Where vesting and distributions are available, their setup resumes from the saved addresses and steps");
    expect(text).toContain("as a vesting series or a distribution does where these are available");
  });

  it("the home page description promises no OTC offers or vesting", async () => {
    const { metadata } = (await import("@/app/page")) as { metadata: { description: string } };
    expect(metadata.description).not.toMatch(/OTC|vesting/);
  });
});

describe("the instruments catalog and /apply state an SPV, a pledge and the raise limit per issuance", () => {
  // Linked from /legal-structure ("Compare the instruments"), /risks,
  // /investors, /about, the header menu and the footer.
  const FACT_SHEET = "@/app/(marketing)/markets/types/[slug]/page";
  const TRANSFERABLE = "Transferable from wallet to wallet; trading through Manci where it is available";

  it("no fact sheet and not the comparison table states an SPV, incorporation or free trading as the rule", async () => {
    const { INSTRUMENT_LIST } = await import("@/lib/instruments");
    for (const { slug } of INSTRUMENT_LIST) {
      const { text, description } = await renderRoute(FACT_SHEET, slug);
      expect(text, slug).not.toMatch(SPV_AS_RULE);
      expect(text, slug).not.toMatch(/\bSerbian\b/);
      // Every "SPV" left is conditional: "per SPV where one is used" or
      // "Where an issuance uses a special purpose vehicle (SPV), …".
      expect(text, slug).not.toMatch(/\bSPV\b(?! where one is used)(?!\), Manci can incorporate one)/);
      expect(description ?? "", slug).not.toMatch(/SPV|Serbian/);
    }
    const index = await render("@/app/(marketing)/markets/types/page");
    expect(index.text).not.toMatch(SPV_AS_RULE);
    expect(index.text).not.toMatch(/\bSerbian\b/);
  });

  it("company ownership (MANCI0's category), debt and revenue share: SPV and pledge per issuance, the limit as the Terms set it", async () => {
    for (const slug of ["equity", "debt", "revenue_share"]) {
      const { text } = await renderRoute(FACT_SHEET, slug);
      expect(text, slug).toContain("Special purpose vehicle Per issuance");
      expect(text, slug).toContain("Raise limit EUR 3,000,000 per issuer over any twelve months (per SPV where one is used)");
      expect(text, slug).toContain(
        "Where an issuance uses a special purpose vehicle (SPV), Manci can incorporate one for the issuer",
      );
      expect(text, slug).toContain("At most EUR 3,000,000 raised per issuer over any twelve months; per SPV where one is used");
      expect(text, slug).toContain(TRANSFERABLE);
      expect(text, slug).not.toMatch(/Special purpose vehicle Required|Share pledge Available/);
    }
    const equity = await renderRoute(FACT_SHEET, "equity");
    expect(equity.description).toBe("A token that can carry the right to become an actual shareholder in your company.");
    expect(equity.text).toContain("Share pledge Per issuance");
    expect(equity.text).toContain("Conversion Where offered · share transfer off-chain");
    expect(equity.text).toContain("Where a share pledge is registered, it is what makes that recourse worth something.");
    expect(equity.text).not.toContain("The registered share pledge is what makes");
  });

  it("the catalog data carries no SPV rule either, rendered or not (lib/instruments.ts, lib/asset-types.tsx)", async () => {
    const { INSTRUMENT_LIST, SETTLED_ANCHORS } = await import("@/lib/instruments");
    const { ASSET_TYPES } = await import("@/lib/asset-types");
    const copy = [...strings(INSTRUMENT_LIST), ...strings(SETTLED_ANCHORS), ...strings(ASSET_TYPES)];
    expect(copy.length).toBeGreaterThan(100);
    for (const line of copy) {
      expect(line, line).not.toMatch(SPV_AS_RULE);
      if (/\bSPV\b/.test(line) && line !== "SPV reference") {
        expect(line, line).toMatch(/where one is used|where (an|the) issuance uses/i);
      }
    }
  });

  it("/apply: incorporation and the raise limit are per issuance, in every state of the wizard", () => {
    const apply = src("app/(marketing)/apply/page.tsx");
    expect(apply).not.toMatch(SPV_AS_RULE);
    expect(apply).not.toMatch(/Serbian SPV|capped at EUR 3 million per SPV/);
    // The verification gate, the individual's card and the incorporation hint.
    expect(apply).toContain("once it is approved you can apply, and where your issuance needs a company, Manci can incorporate one.");
    expect(apply).toContain("Your identity is verified. Where your issuance needs a company, Manci can incorporate one");
    expect(apply).toContain('"You are applying as an individual. Where your issuance needs a company, Manci can incorporate one."');
    expect(apply).toContain(
      '"Where your issuance uses a special purpose vehicle and you have no company for it, Manci can incorporate one."',
    );
    expect(apply).toMatch(
      /Each issuer can raise at most EUR 3,000,000 over any twelve\s+months \(per special purpose vehicle where one is used\)\./,
    );
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

  it("/docs/pilot forwards to /docs/recovery with a temporary (307) redirect", async () => {
    const { default: FormerPilotGuide } = (await import("@/app/docs/pilot/page")) as { default: () => unknown };
    let thrown: unknown = null;
    try {
      FormerPilotGuide();
    } catch (error) {
      thrown = error;
    }
    // next/navigation's redirect() throws NEXT_REDIRECT;<type>;<url>;<status>;
    expect((thrown as { digest?: string } | null)?.digest).toMatch(/^NEXT_REDIRECT;(replace|push);\/docs\/recovery;307;/);
    expect(src("app/docs/pilot/page.tsx")).not.toMatch(/<[A-Z]/); // no page of its own left behind
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
