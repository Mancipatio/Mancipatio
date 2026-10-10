// Pilot scope in the navigation (lib/pilot-scope.ts navHrefVisible): with a
// module switched off on this network, its menu entries, section tabs, admin
// entries, footer links and guides are not rendered at all (no "not
// available" stubs in the menus); the pages stay reachable by URL with their
// notice. Devnet shows everything (modules default on). The menus are
// rendered to static markup (no jsdom here), with the wallet-bound pieces
// stubbed. The app sidebar is also the mobile menu (the ☰ button opens the
// same <aside>), so one render covers both.
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ path: "/portfolio" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.path }));
vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) =>
    createElement("a", { href, className }, children),
}));
vi.mock("@/components/account-menu", () => ({ AccountMenu: () => null }));
vi.mock("@/components/tos-gate", () => ({ TosGate: () => null }));
vi.mock("@/components/brand-logo", () => ({ BrandLogo: () => createElement("span", null, "Manci") }));
// Every operator capability, so only the pilot scope hides an admin entry.
vi.mock("@/lib/auth", () => ({
  useRole: () => ({ capabilities: new Set(["superAdmin", "admin", "issuer", "kycProvider", "blocklistAuthority"]) }),
}));

import { PILOT_MODULE_ENV } from "@/lib/features";
import { NAV_ROUTES, navHrefVisible } from "@/lib/pilot-scope";
import { AppShell } from "@/components/app-shell";
import { AdminNavGroups } from "@/app/admin/admin-nav-groups";
import { ADMIN_MENU } from "@/app/admin/admin-menu";
import { AdminBadgesContext } from "@/components/admin-badges-context";
import { NO_BADGE_MENU, type BadgeMenu } from "@/lib/admin-badges";
import { SiteFooter } from "@/components/mx/site-footer";
import { DocumentationIndex } from "@/components/documentation-index";

const html = (node: ReactNode) => renderToStaticMarkup(node as never);
const hrefs = (markup: string) => [...markup.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
const sidebar = (markup: string) => markup.slice(markup.indexOf('id="app-sidebar"'), markup.indexOf("</aside>"));
const tabs = (markup: string) => {
  const start = markup.indexOf('class="app-section-tabs"');
  return start < 0 ? "" : markup.slice(start, markup.indexOf("</nav>", start));
};

function network(name: "mainnet" | "devnet", on: Partial<Record<keyof typeof PILOT_MODULE_ENV, string>> = {}) {
  vi.stubEnv("NEXT_PUBLIC_NETWORK", name);
  for (const [module, variable] of Object.entries(PILOT_MODULE_ENV)) {
    vi.stubEnv(variable, on[module as keyof typeof PILOT_MODULE_ENV] ?? "");
  }
  vi.stubEnv("NEXT_PUBLIC_FEATURE_STARTUP_RAISES", "");
  vi.stubEnv("NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP", "");
}

function shell(section: "portfolio" | "marketplace" | "issuer", path: string) {
  nav.path = path;
  // AppShell types `children` as a required prop (a .ts test has no JSX).
  // eslint-disable-next-line react/no-children-prop
  return html(createElement(AppShell, { section, children: createElement("p", null, "page") }));
}

function adminMenu(badges: BadgeMenu = NO_BADGE_MENU) {
  nav.path = "/admin";
  return html(createElement(AdminBadgesContext.Provider, { value: badges }, createElement(AdminNavGroups, { groups: ADMIN_MENU })));
}

const OFF_ON_MAINNET_USER = [
  "/marketplace/otc", "/marketplace/governance", "/markets/resell",
  "/portfolio/offers", "/portfolio/deals", "/portfolio/listings", "/portfolio/vesting",
  "/portfolio/rights", "/portfolio/governance", "/portfolio/delivery",
  "/issuer/payouts", "/issuer/vesting", "/issuer/vesting-series",
];
const OFF_ON_MAINNET_ADMIN = ["/admin/otc", "/admin/resell", "/admin/governance", "/admin/rights", "/admin/vesting", "/admin/payouts"];

beforeEach(() => network("devnet"));
afterEach(() => vi.unstubAllEnvs());

describe("navHrefVisible: menu-only routes (NAV_ROUTES)", () => {
  it("mainnet by default: issuer payout vaults and the guides of off modules are hidden", () => {
    network("mainnet");
    for (const prefix of NAV_ROUTES.map((r) => r.prefix)) expect(navHrefVisible(prefix), prefix).toBe(false);
    expect(navHrefVisible("/solutions/launchpad")).toBe(true);
    expect(navHrefVisible("/marketplace/launchpad")).toBe(true);
  });

  it("a query or hash does not hide or reveal a page", () => {
    network("mainnet");
    expect(navHrefVisible("/markets/resell?type=equity")).toBe(false);
    expect(navHrefVisible("/admin/payouts#push-distributions")).toBe(false);
    expect(navHrefVisible("/markets/types?x=1")).toBe(true);
  });

  it("a menu-only page is back once one of its modules or flags is on", () => {
    network("mainnet", { custodyConversion: "true" });
    expect(navHrefVisible("/solutions/custody")).toBe(true);
    expect(navHrefVisible("/portfolio/conversion")).toBe(true);
    expect(navHrefVisible("/portfolio/delivery")).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_FEATURE_STARTUP_RAISES", "true");
    expect(navHrefVisible("/issuer/payouts")).toBe(true);
  });

  it("devnet: everything is visible", () => {
    for (const href of [...OFF_ON_MAINNET_USER, ...OFF_ON_MAINNET_ADMIN, ...NAV_ROUTES.map((r) => r.prefix)]) {
      expect(navHrefVisible(href), href).toBe(true);
    }
  });
});

describe("AppShell: sidebar (also the mobile menu) and section tabs", () => {
  it("mainnet with only conversion on: no entry or tab of an off module", () => {
    network("mainnet", { custodyConversion: "true" });
    const portfolio = shell("portfolio", "/portfolio");
    const links = [...hrefs(sidebar(portfolio)), ...hrefs(tabs(portfolio))];
    for (const href of OFF_ON_MAINNET_USER) expect(links, href).not.toContain(href);
    expect(hrefs(sidebar(portfolio))).toEqual(expect.arrayContaining(["/", "/marketplace", "/marketplace/launchpad", "/account", "/portfolio", "/issuer", "/docs"]));
    expect(hrefs(tabs(portfolio))).toEqual(["/portfolio", "/portfolio/conversion", "/portfolio/history"]);

    expect(hrefs(tabs(shell("marketplace", "/marketplace")))).toEqual(["/marketplace", "/marketplace/launchpad"]);
    const issuer = hrefs(tabs(shell("issuer", "/issuer")));
    expect(issuer).toEqual(expect.arrayContaining(["/issuer", "/issuer/assets", "/issuer/share-classes", "/issuer/launchpad"]));
    for (const href of ["/issuer/payouts", "/issuer/vesting", "/issuer/vesting-series"]) expect(issuer).not.toContain(href);
  });

  it("mainnet with every module switched on: the entries and tabs are back", () => {
    network("mainnet", Object.fromEntries(Object.keys(PILOT_MODULE_ENV).map((m) => [m, "true"])));
    const portfolio = shell("portfolio", "/portfolio");
    const links = [...hrefs(sidebar(portfolio)), ...hrefs(tabs(portfolio))];
    for (const href of ["/marketplace/otc", "/portfolio/vesting", "/portfolio/rights", "/portfolio/governance", "/portfolio/delivery", "/portfolio/offers", "/portfolio/deals", "/portfolio/listings", "/portfolio/conversion"]) {
      expect(links, href).toContain(href);
    }
    expect(hrefs(tabs(shell("marketplace", "/marketplace")))).toEqual(expect.arrayContaining(["/marketplace/otc", "/marketplace/governance", "/markets/resell"]));
  });

  it("devnet shows every entry and tab", () => {
    const links = [...hrefs(sidebar(shell("portfolio", "/portfolio"))), ...hrefs(tabs(shell("portfolio", "/portfolio")))];
    for (const href of OFF_ON_MAINNET_USER.filter((h) => h.startsWith("/portfolio") || h === "/marketplace/otc")) expect(links, href).toContain(href);
    expect(hrefs(tabs(shell("issuer", "/issuer")))).toEqual(expect.arrayContaining(["/issuer/payouts", "/issuer/vesting", "/issuer/vesting-series"]));
  });

  it("an off module's page is still served by URL, with its notice", () => {
    network("mainnet");
    const page = shell("portfolio", "/portfolio/vesting");
    expect(page).toContain("not available on Solana mainnet");
    expect(page).toContain("<p>page</p>");
  });
});

describe("Admin menu", () => {
  it("mainnet: off modules leave the menu; Custody (conversion on) and the core stay", () => {
    network("mainnet", { custodyConversion: "true" });
    const links = hrefs(adminMenu());
    for (const href of OFF_ON_MAINNET_ADMIN) expect(links, href).not.toContain(href);
    expect(links).toEqual(expect.arrayContaining(["/admin", "/admin/issuers", "/admin/assets", "/admin/share-classes", "/admin/launchpad", "/admin/custody", "/admin/kyc", "/admin/fees", "/admin/platform", "/admin/documents"]));
  });

  it("mainnet: Custody leaves too when conversion and delivery are both off", () => {
    network("mainnet");
    expect(hrefs(adminMenu())).not.toContain("/admin/custody");
  });

  it("an off module's page stays in the menu while something waits there (an exit to process)", () => {
    network("mainnet");
    const waiting: BadgeMenu = {
      view: (href) => (href === "/admin/otc" ? { text: "2", srText: "2 waiting", title: "2 waiting", muted: false, fresh: false } : null),
      total: null,
    };
    const links = hrefs(adminMenu(waiting));
    expect(links).toContain("/admin/otc");
    expect(links).not.toContain("/admin/governance");
    // An unread count (the "•") is not something waiting.
    const unknown: BadgeMenu = { view: () => ({ text: "•", srText: "", title: "", muted: true, fresh: false }), total: null };
    expect(hrefs(adminMenu(unknown))).not.toContain("/admin/otc");
  });

  it("mainnet with the modules on, and devnet: every entry is in the menu", () => {
    network("mainnet", Object.fromEntries(Object.keys(PILOT_MODULE_ENV).map((m) => [m, "true"])));
    expect(hrefs(adminMenu())).toEqual(expect.arrayContaining([...OFF_ON_MAINNET_ADMIN, "/admin/custody"]));
    network("devnet");
    expect(hrefs(adminMenu())).toEqual(expect.arrayContaining([...OFF_ON_MAINNET_ADMIN, "/admin/custody"]));
  });
});

describe("Public footer and documentation", () => {
  it("mainnet: no resell board in the footer, no guide of an off module in /docs", () => {
    network("mainnet", { custodyConversion: "true" });
    expect(hrefs(html(createElement(SiteFooter)))).not.toContain("/markets/resell");
    const docs = hrefs(html(createElement(DocumentationIndex)));
    for (const href of ["/solutions/otc", "/solutions/governance", "/solutions/rights-vesting"]) expect(docs).not.toContain(href);
    expect(docs).toEqual(expect.arrayContaining(["/solutions/launchpad", "/solutions/custody", "/solutions/compliance"]));
  });

  it("devnet: the footer and /docs list them", () => {
    expect(hrefs(html(createElement(SiteFooter)))).toContain("/markets/resell");
    expect(hrefs(html(createElement(DocumentationIndex)))).toEqual(expect.arrayContaining(["/solutions/otc", "/solutions/governance", "/solutions/rights-vesting"]));
  });
});
