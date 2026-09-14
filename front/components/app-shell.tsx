"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AccountMenu } from "@/components/account-menu";
import { BrandLogo } from "@/components/brand-logo";
import { NetworkBadge } from "@/components/network-badge";
import { LegacyAccountsNotice } from "@/components/legacy-accounts-notice";
import { TosGate } from "@/components/tos-gate";
import { IconHome, IconLayers, IconRocket, IconRepeat, IconWallet, IconLock, IconCoins, IconGavel, IconBox, IconBuilding, IconFile, IconArrowUpRight } from "@/components/icons";
import { detectNetwork, networkLabel } from "@/lib/network";

const primary = [
  { href: "/", label: "Overview", icon: IconHome },
  { href: "/marketplace", label: "Explore assets", icon: IconLayers },
  { href: "/marketplace/launchpad", label: "Primary sales", icon: IconRocket },
  { href: "/marketplace/otc", label: "OTC market", icon: IconRepeat },
];
const portfolio = [
  { href: "/portfolio", label: "My portfolio", icon: IconWallet },
  { href: "/portfolio/vesting", label: "Vesting", icon: IconLock },
  { href: "/portfolio/rights", label: "Income & claims", icon: IconCoins },
  { href: "/portfolio/governance", label: "Governance", icon: IconGavel },
  { href: "/portfolio/delivery", label: "Delivery", icon: IconBox },
];
const portfolioTabs = [
  ["/portfolio", "Holdings"], ["/portfolio/offers", "My offers"], ["/portfolio/deals", "Deals"],
  ["/portfolio/listings", "Sell listings"], ["/portfolio/vesting", "Vesting"], ["/portfolio/rights", "Rights & claims"],
  ["/portfolio/governance", "Votes"], ["/portfolio/delivery", "Delivery"], ["/portfolio/conversion", "Conversion"], ["/portfolio/history", "Activity"],
];
const issuerTabs = [
  ["/issuer", "Overview"], ["/issuer/assets", "Assets"], ["/issuer/share-classes", "Share classes"],
  ["/issuer/launchpad", "Sales"], ["/issuer/payouts", "Payout vaults"], ["/issuer/vesting", "Vesting"], ["/issuer/vesting-series", "Vesting series"],
];
const marketTabs = [
  ["/marketplace", "Assets"], ["/marketplace/launchpad", "Primary sales"],
  ["/marketplace/otc", "OTC offers"], ["/marketplace/governance", "Governance"],
  ["/markets/resell", "Resell board"],
];

function activePath(path: string, href: string) {
  if (["/", "/marketplace", "/portfolio", "/issuer"].includes(href)) return path === href;
  return path === href || path.startsWith(`${href}/`);
}

export function AppShell({ children, section = "overview" }: {
  children: ReactNode;
  section?: "overview" | "marketplace" | "portfolio" | "issuer" | "documentation" | "admin" | "application" | "onboarding";
}) {
  const path = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const [previousPath, setPreviousPath] = useState(path);
  if (previousPath !== path) { setPreviousPath(path); setMenuOpen(false); }
  useEffect(() => {
    if (!menuOpen) return;
    sidebar.current?.querySelector<HTMLAnchorElement>("a")?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") { setMenuOpen(false); menuButton.current?.focus(); }
      if (event.key === "Tab") {
        const links = sidebar.current?.querySelectorAll<HTMLElement>("a, button");
        if (!links?.length) return;
        const first = links[0], last = links[links.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener("keydown", onKey);
    const desktop = window.matchMedia("(min-width: 761px)");
    function onViewportChange(event: MediaQueryListEvent) {
      if (event.matches) setMenuOpen(false);
    }
    desktop.addEventListener("change", onViewportChange);
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); desktop.removeEventListener("change", onViewportChange); document.body.style.overflow = originalOverflow; };
  }, [menuOpen]);
  const tabs = section === "portfolio" ? portfolioTabs : section === "issuer" ? issuerTabs : section === "marketplace" ? marketTabs : null;
  const currentTitle = [...primary, ...portfolio].find((item) => activePath(path, item.href))?.label
    ?? (section === "documentation" ? "Documentation" : section === "admin" ? "Administration" : section === "application" ? "Create a raise" : section === "onboarding" ? "Onboarding" : section === "issuer" ? "Issuer workspace" : section === "portfolio" ? "My portfolio" : "Marketplace");
  const network = detectNetwork();
  // Existing holder and issuer pages own their main landmark.
  const Content = section === "portfolio" || section === "issuer" ? "div" : "main";
  const navItems = (items: typeof primary) => items.map(({ href, label, icon: Icon }) => (
    <Link key={href} href={href} aria-current={activePath(path, href) ? "page" : undefined}
      className={`app-nav-link ${activePath(path, href) ? "is-active" : ""}`}>
      <Icon className="h-[18px] w-[18px]" /><span>{label}</span>
      {activePath(path, href) && <span className="app-nav-indicator" />}
    </Link>
  ));
  return (
    <div className="app-shell" data-app>
      <a href="#app-content" className="app-skip">Skip to content</a>
      {menuOpen && <button className="app-sidebar-backdrop" aria-label="Close navigation" onClick={() => { setMenuOpen(false); menuButton.current?.focus(); }} />}
      <aside ref={sidebar} id="app-sidebar" className={`app-sidebar ${menuOpen ? "is-open" : ""}`} aria-label="Application navigation">
        <Link href="/" className="app-wordmark"><BrandLogo /></Link>
        <button className="app-menu-close" onClick={() => { setMenuOpen(false); menuButton.current?.focus(); }}>Close menu <span aria-hidden="true">×</span></button>
        <nav aria-label="Main app">
          <p className="app-nav-label">MARKETPLACE</p>{navItems(primary)}
          <p className="app-nav-label">YOUR WORKSPACE</p>{navItems(portfolio)}
          <p className="app-nav-label">BUILD ON MANCIPATIO</p>
          <Link href="/issuer" className={`app-nav-link ${section === "issuer" ? "is-active" : ""}`}><IconBuilding className="h-[18px] w-[18px]" />Issuer workspace</Link>
          <Link href="/docs" className={`app-nav-link ${section === "documentation" ? "is-active" : ""}`} aria-current={section === "documentation" ? "location" : undefined}><IconFile className="h-[18px] w-[18px]" />Documentation</Link>
          {section === "admin" && <Link href="/admin" className="app-nav-link is-active" aria-current="location"><IconBuilding className="h-[18px] w-[18px]" />Administration</Link>}
        </nav>
        <div className="app-sidebar-bottom">
          <div className="app-issue-card"><span className="app-issue-symbol">↗</span><strong>Bring your asset on-chain.</strong><p>Start an equity raise or explore tokenization.</p><Link href="/apply">Create a raise <IconArrowUpRight className="h-4 w-4" /></Link></div>
          <div className="app-sidebar-foot"><Link href="/about">About Mancipatio ↗</Link><span><i />Solana · {networkLabel(network)}</span></div>
        </div>
      </aside>
      <div className="app-body">
        <header className="app-topbar">
          <div className="app-breadcrumb"><button ref={menuButton} className="app-menu-button" aria-label="Open navigation" aria-expanded={menuOpen} aria-controls="app-sidebar" onClick={() => setMenuOpen(true)}>☰</button><span className="app-breadcrumb-root">Workspace</span><span className="app-breadcrumb-separator">/</span><span>{currentTitle}</span></div>
          <div className="app-topbar-actions"><NetworkBadge /><div className="app-account"><AccountMenu /></div></div>
        </header>
        {network !== "mainnet" && <div className="app-network-notice"><span className="app-notice-dot" /><strong>{networkLabel(network)} environment</strong><span>Test assets and transactions. No real-world value.</span><Link href="/security">How it works <span aria-hidden="true">↗</span></Link></div>}
        <LegacyAccountsNotice />
        {tabs && <nav className="app-section-tabs" aria-label={`${section} pages`}>{tabs.map(([href, label]) => <Link key={href} href={href} aria-current={activePath(path, href) ? "page" : undefined} className={activePath(path, href) ? "is-active" : ""}>{label}</Link>)}</nav>}
        <Content id="app-content" tabIndex={-1} className={`app-content app-content--${section}`}>
          {section === "marketplace" || section === "application" ? <div data-mx className="app-market-content">{children}</div> : children}
        </Content>
        <footer className="app-footer"><span>Mancipatio <span className="app-footer-dot">·</span> Real-world assets on Solana</span><div><Link href="/risks">Risks</Link><Link href="/legal/terms">Terms</Link><Link href="/contact">Support ↗</Link></div></footer>
      </div>
      {!["documentation", "admin", "onboarding", "application"].includes(section) && !path.startsWith("/markets/") && <TosGate />}
    </div>
  );
}
