// KYC-only mode in the UI (lib/pilot-scope.ts): with the mode on, the menus,
// tabs, guides, footer and shared buttons carry no link into what it pauses
// (primary sales, issuance, every module); the paused pages say "Paused." or
// are replaced by the notice; sign-in, the verification request, the
// portfolio and the admin console stay, and the one open action
// (identity verification) is offered in the sidebar and the wallet menu.
// With the mode off (mainnet read as off, devnet by default) the menus are
// today's. Rendered to static markup like tests/nav-scope.test.ts, whose
// mocks this file copies.
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The issuer tabs are computed when components/app-shell.tsx loads (the
// rotation tab follows features().issuerRotation): load it as mainnet, where
// that flag is off unless set.
vi.hoisted(() => {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
  vi.stubEnv("NEXT_PUBLIC_FEATURE_ISSUER_ROTATION", "");
});

const nav = vi.hoisted(() => ({ path: "/portfolio", search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: () => {} }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) =>
    createElement("a", { href, className }, children),
}));
vi.mock("@/components/account-menu", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/account-menu")>()),
  AccountMenu: () => null,
}));
vi.mock("@/components/tos-gate", () => ({ TosGate: () => null }));
vi.mock("@/components/brand-logo", () => ({ BrandLogo: () => createElement("span", null, "Manci") }));
vi.mock("@/components/wallet-required", () => ({ WalletRequired: () => null }));
// Every operator capability, so only the scope hides an admin entry.
vi.mock("@/lib/auth", () => ({
  useRole: () => ({ capabilities: new Set(["superAdmin", "admin", "issuer", "kycProvider", "blocklistAuthority"]), isIssuer: true, pending: [] }),
}));
vi.mock("@solana/react-hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@solana/react-hooks")>()),
  useWalletConnection: () => ({ isReady: true, connected: true, wallet: { account: { address: { toString: () => "TestWallet" } } } }),
  useBalance: () => ({ lamports: null }),
}));
vi.mock("@/lib/account-login", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/account-login")>()),
  useSignedInAccount: () => ({ status: "signed_out", account: null }),
}));

import { KYC_ONLY_ENV, KYC_ONLY_MESSAGE, PILOT_MODULE_ENV } from "@/lib/features";
import { AppShell } from "@/components/app-shell";
import { walletMenuLinks } from "@/components/account-menu";
import { AdminNavGroups } from "@/app/admin/admin-nav-groups";
import { ADMIN_MENU } from "@/app/admin/admin-menu";
import { AdminBadgesContext } from "@/components/admin-badges-context";
import { NO_BADGE_MENU, type BadgeMenu } from "@/lib/admin-badges";
import { SiteFooter } from "@/components/mx/site-footer";
import { DocumentationIndex } from "@/components/documentation-index";
import { DocumentationFrame } from "@/components/documentation-frame";
import { Button, TextLink } from "@/components/mx/button";
import { AccountVerificationCard, kybShown } from "@/components/account-verification";
import { VerificationForm } from "@/components/verification-form";
import type { AccountVerification } from "@/lib/account";

const html = (node: ReactNode) => renderToStaticMarkup(node as never);
const hrefs = (markup: string) => [...markup.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
const sidebar = (markup: string) => markup.slice(markup.indexOf('id="app-sidebar"'), markup.indexOf("</aside>"));
const tabs = (markup: string) => {
  const start = markup.indexOf('class="app-section-tabs"');
  return start < 0 ? "" : markup.slice(start, markup.indexOf("</nav>", start));
};

/** `kyc` "" is unset: on on mainnet, off on devnet. */
function network(name: "mainnet" | "devnet", kyc = "", on: Partial<Record<keyof typeof PILOT_MODULE_ENV, string>> = {}) {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", name);
  vi.stubEnv(KYC_ONLY_ENV, kyc);
  vi.stubEnv("NEXT_PUBLIC_ASSET_CLASSES", "");
  for (const [module, variable] of Object.entries(PILOT_MODULE_ENV)) {
    vi.stubEnv(variable, on[module as keyof typeof PILOT_MODULE_ENV] ?? "");
  }
  vi.stubEnv("NEXT_PUBLIC_FEATURE_STARTUP_RAISES", "");
  vi.stubEnv("NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP", "");
}

type Section = "portfolio" | "marketplace" | "issuer" | "application" | "account";
function shell(section: Section, path: string) {
  nav.path = path;
  // AppShell types `children` as a required prop (a .ts test has no JSX).
  // eslint-disable-next-line react/no-children-prop
  return html(createElement(AppShell, { section, children: createElement("p", null, "page") }));
}

function adminMenu(badges: BadgeMenu = NO_BADGE_MENU) {
  nav.path = "/admin";
  return html(createElement(AdminBadgesContext.Provider, { value: badges }, createElement(AdminNavGroups, { groups: ADMIN_MENU })));
}

const MODULE_PAGES = [
  "/marketplace/otc", "/marketplace/governance", "/markets/resell", "/portfolio/offers", "/portfolio/deals",
  "/portfolio/listings", "/portfolio/vesting", "/portfolio/rights", "/portfolio/governance", "/portfolio/delivery",
  "/portfolio/conversion", "/issuer/payouts", "/issuer/vesting", "/issuer/vesting-series",
];

beforeEach(() => {
  network("mainnet");
  nav.search = "";
});
afterEach(() => vi.unstubAllEnvs());

describe("AppShell with the mode on (mainnet default)", () => {
  it("sidebar: browsing, the account and the portfolio; no sale, issuer, raise or module entry; the promo offers verification", () => {
    network("mainnet", "", { custodyConversion: "true" });
    const side = hrefs(sidebar(shell("portfolio", "/portfolio")));
    expect(side).toEqual(expect.arrayContaining(["/", "/marketplace", "/account", "/portfolio", "/docs", "/verify"]));
    for (const href of ["/marketplace/launchpad", "/issuer", "/apply", ...MODULE_PAGES]) expect(side, href).not.toContain(href);
    expect(sidebar(shell("portfolio", "/portfolio"))).toContain("Identity verification is open.");
  });

  it("section tabs: the portfolio overview and activity, the asset directory, and no issuer tabs at all", () => {
    network("mainnet", "", { custodyConversion: "true" });
    expect(hrefs(tabs(shell("portfolio", "/portfolio")))).toEqual(["/portfolio", "/portfolio/history"]);
    expect(hrefs(tabs(shell("marketplace", "/marketplace")))).toEqual(["/marketplace"]);
    expect(shell("issuer", "/issuer")).not.toContain('class="app-section-tabs"');
  });

  it("the launchpad list and the raise application are replaced by the notice", () => {
    for (const [section, path] of [["marketplace", "/marketplace/launchpad"], ["application", "/apply"]] as const) {
      const page = shell(section, path);
      expect(page, path).toContain("Paused.");
      expect(page, path).toContain(KYC_ONLY_MESSAGE);
      expect(page, path).not.toContain("<p>page</p>");
    }
  });

  it("a sale page and an issuer asset page keep their content under the notice", () => {
    for (const [section, path] of [["marketplace", "/marketplace/launchpad/S"], ["issuer", "/issuer/assets/x"]] as const) {
      const page = shell(section, path);
      expect(page, path).toContain(KYC_ONLY_MESSAGE);
      expect(page, path).toContain("<p>page</p>");
    }
  });

  it("a module page keeps its own label, with the same sentence", () => {
    const page = shell("portfolio", "/portfolio/conversion");
    expect(page).toContain("Not available.");
    expect(page).toContain(KYC_ONLY_MESSAGE);
  });

  it("operator tools, the verification request and the portfolio carry no notice", () => {
    for (const [section, path] of [["issuer", "/issuer/authority"], ["account", "/verify"], ["portfolio", "/portfolio"], ["portfolio", "/portfolio/history"]] as const) {
      const page = shell(section, path);
      expect(page, path).not.toContain("data-pilot-module-notice");
      expect(page, path).toContain("<p>page</p>");
    }
  });
});

describe("the wallet menu", () => {
  const links = () => walletMenuLinks({ isIssuer: true, adminAllowed: false, pendingRoles: 0 }).map((l) => l.href);

  it("mode on: Verification is offered, the issuer dashboard is not", () => {
    expect(links()).toEqual(["/account", "/verify", "/portfolio"]);
  });

  it("mode off: today's list", () => {
    network("mainnet", "off");
    expect(links()).toEqual(["/account", "/portfolio", "/issuer"]);
    network("devnet");
    expect(links()).toEqual(["/account", "/portfolio", "/issuer"]);
  });
});

describe("the admin console is unaffected", () => {
  it("mode on: the KYC, client, platform and recording entries stay; Custody only while something waits", () => {
    network("mainnet", "", { custodyConversion: "true" });
    const links = hrefs(adminMenu());
    expect(links).toEqual(expect.arrayContaining([
      "/admin/kyc", "/admin/clients", "/admin/platform", "/admin/issuers", "/admin/assets",
      "/admin/share-classes", "/admin/launchpad", "/admin/documents",
    ]));
    expect(links).not.toContain("/admin/custody");
    const waiting: BadgeMenu = {
      view: (href) => (href === "/admin/custody" ? { text: "1", srText: "1 waiting", title: "1 waiting", muted: false, fresh: false } : null),
      total: null,
    };
    expect(hrefs(adminMenu(waiting))).toContain("/admin/custody");
  });
});

describe("guides, footer and shared links", () => {
  it("mode on: the guides of the paused areas leave /docs and its sidebar", () => {
    const docs = hrefs(html(createElement(DocumentationIndex)));
    for (const href of ["/solutions/launchpad", "/solutions/issuer-registry", "/solutions/tokenization", "/solutions/share-classes"]) {
      expect(docs, href).not.toContain(href);
    }
    expect(docs).toEqual(expect.arrayContaining(["/solutions/compliance", "/markets/types"]));
    nav.path = "/docs";
    // eslint-disable-next-line react/no-children-prop
    const frame = hrefs(html(createElement(DocumentationFrame, { children: createElement("p", null, "doc") })));
    for (const href of ["/solutions/launchpad", "/solutions/tokenization", "/solutions/otc"]) expect(frame, href).not.toContain(href);
    expect(frame).toContain("/solutions/compliance");
  });

  it("mode off: the docs sidebar lists the guides of what is in scope, as the index does", () => {
    network("mainnet", "off");
    nav.path = "/docs";
    // eslint-disable-next-line react/no-children-prop
    const frame = hrefs(html(createElement(DocumentationFrame, { children: createElement("p", null, "doc") })));
    expect(frame).toEqual(expect.arrayContaining(["/solutions/launchpad", "/solutions/tokenization", "/solutions/compliance"]));
    expect(frame).not.toContain("/solutions/otc");
  });

  it("the footer: no raise application, and only the offered asset class", () => {
    const footer = hrefs(html(createElement(SiteFooter)));
    expect(footer).not.toContain("/apply");
    expect(footer.filter((href) => href.startsWith("/markets/types/"))).toEqual(["/markets/types/equity"]);
  });

  it("mx Button and TextLink: no link into what the mode pauses; the words of a TextLink stay", () => {
    // Both type `children` as a required prop (a .ts test has no JSX).
    /* eslint-disable react/no-children-prop */
    const button = (href: string) => html(createElement(Button, { href, children: "Go" }));
    const textLink = (href: string) => html(createElement(TextLink, { href, children: "custody guide" }));
    /* eslint-enable react/no-children-prop */
    expect(button("/apply")).toBe("");
    expect(button("/verify")).toContain('href="/verify"');
    const text = textLink("/solutions/custody");
    expect(text).toContain("custody guide");
    expect(text).not.toContain("href=");
    // A trailing link arrow goes with the link (/docs/pilot "Issuer operations →").
    // eslint-disable-next-line react/no-children-prop
    expect(html(createElement(TextLink, { href: "/issuer/share-classes", children: "Issuer operations →" }))).toBe("<span>Issuer operations</span>");
    network("mainnet", "off");
    expect(button("/apply")).toContain('href="/apply"');
    network("devnet");
    expect(textLink("/solutions/custody")).toContain('href="/solutions/custody"');
  });
});

describe("the verification request", () => {
  const verification = { kyc: "none", kyb: "none", documents_requested: 0 } as unknown as AccountVerification;

  it("mode on: identity (KYC) only; ?type=kyb is ignored and the company (KYB) request is not offered", () => {
    nav.path = "/verify";
    nav.search = "type=kyb";
    const form = html(createElement(VerificationForm));
    expect(form).toContain("Individual (KYC)");
    expect(form).not.toContain("Company (KYB)");
    expect(form).not.toContain("COMPANY REPRESENTATIVE");
    expect(form).not.toContain("Buying and trading tokens");
    const card = html(createElement(AccountVerificationCard, { verification }));
    expect(card).toContain("Identity verification (KYC)");
    expect(card).not.toContain("Company verification (KYB)");
    expect(card).not.toContain("Buying and trading tokens");
  });

  it("mode on: a KYB dossier that exists keeps its row, status and 'Continue verification'; a new one is not offered", () => {
    for (const kyb of ["pending", "more_info", "verified", "suspended", "rejected"] as const) {
      expect(kybShown(kyb), kyb).toBe(true);
      const card = html(createElement(AccountVerificationCard, { verification: { ...verification, kyb, documents_requested: 2 } as AccountVerification }));
      expect(card, kyb).toContain("Company verification (KYB)");
    }
    const waiting = html(createElement(AccountVerificationCard, { verification: { ...verification, kyb: "more_info", documents_requested: 2 } as AccountVerification }));
    expect(waiting).toContain("Documents needed");
    expect(waiting).toContain("Continue verification");
    expect(hrefs(waiting)).toContain("/verify?type=kyb");
    for (const kyb of ["none", "expired", null, undefined] as const) {
      expect(kybShown(kyb), String(kyb)).toBe(false);
    }
    const expired = html(createElement(AccountVerificationCard, { verification: { ...verification, kyb: "expired" } as AccountVerification }));
    expect(expired).not.toContain("Company verification (KYB)");
  });

  it("mode on: the copy promises nothing about when other services open", () => {
    nav.path = "/verify";
    const text = html(createElement(VerificationForm)) + html(createElement(AccountVerificationCard, { verification }));
    expect(text).toContain("Identity verification (KYC) is open. The services that require it are not available at the moment.");
    expect(text).toContain("Identity verification is open.");
    expect(text).not.toMatch(/open later|Open now/);
  });

  it("mode off: both, as today", () => {
    network("mainnet", "off");
    nav.path = "/verify";
    nav.search = "type=kyb";
    const form = html(createElement(VerificationForm));
    expect(form).toContain("Company (KYB)");
    expect(form).toContain("COMPANY REPRESENTATIVE");
    expect(html(createElement(AccountVerificationCard, { verification }))).toContain("Company verification (KYB)");
    for (const kyb of ["none", "expired", "more_info"] as const) expect(kybShown(kyb), kyb).toBe(true);
  });
});

describe("the About page (its honest line and its way in)", () => {
  const about = async () => {
    vi.resetModules();
    const { default: AboutPage } = await import("@/app/(marketing)/about/page");
    return html(createElement(AboutPage));
  };

  it("mode on: issuer applications are named as paused, never as open; the way in is verification", async () => {
    const page = await about();
    expect(page).toContain("Sign-up and identity verification open; launchpad and issuer applications paused for now");
    expect(page).not.toContain("Issuer applications are open");
    expect(page).not.toContain("Issuers apply");
    expect(page).toContain(KYC_ONLY_MESSAGE);
    expect(hrefs(page)).toContain("/verify");
    expect(hrefs(page)).not.toContain("/apply");
  });

  it("mode off: today's facts and the two ways in", async () => {
    network("mainnet", "off");
    const page = await about();
    expect(page).toContain("Issuer applications are open and read by a person");
    expect(page).toContain("Two ways in.");
    expect(hrefs(page)).toContain("/apply");
  });
});

describe("the mode off is today's menu", () => {
  for (const [name, kyc] of [["mainnet", "off"], ["devnet", ""]] as const) {
    it(`${name}: primary sales, the issuer workspace and the raise promo are back`, () => {
      network(name, kyc);
      const side = sidebar(shell("portfolio", "/portfolio"));
      expect(hrefs(side)).toEqual(expect.arrayContaining(["/marketplace/launchpad", "/issuer", "/apply"]));
      expect(hrefs(side)).not.toContain("/verify");
      expect(side).toContain("Bring your asset on-chain.");
    });
  }
});
