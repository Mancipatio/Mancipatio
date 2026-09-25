// The admin menu's count pills, rendered to static markup (no jsdom here):
// AdminNav with per-item badges, the pill itself, and the collapsed-menu
// toggle total read from AdminBadgesContext. next/link and next/navigation
// are stubbed; the view data comes from the real lib/admin-badges helpers.
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { badgeMenu, badgeView, EMPTY_BADGES_SNAPSHOT, type BadgeView } from "@/lib/admin-badges";
import type { Capability } from "@/lib/role-resolution";

const nav = vi.hoisted(() => ({ path: "/admin" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.path }));
vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) =>
    createElement("a", { href, className }, children),
}));

import { AdminNav } from "@/app/admin/admin-nav";
import { AdminBadgePill } from "@/components/admin-badge-pill";
import { AdminNavigation } from "@/components/admin-navigation";
import { AdminBadgesContext } from "@/components/admin-badges-context";

const html = (node: ReactNode) => renderToStaticMarkup(node as never);
const pills = (markup: string) => markup.match(/data-admin-badge=""/g)?.length ?? 0;

function items(badges: Record<string, BadgeView | null>) {
  return Object.entries(badges).map(([href, badge]) => ({ href, label: href.split("/").pop() || "Overview", badge }));
}

describe("AdminNav pills", () => {
  it("renders the number with screen-reader text inside the link, and nothing at 0", () => {
    nav.path = "/admin";
    const markup = html(createElement(AdminNav, {
      items: items({
        "/admin/clients": badgeView("/admin/clients", { count: 65, parts: { final: 41, documents: 30 } }),
        "/admin/otc": badgeView("/admin/otc", { count: 0 }),
        "/admin/fees": null,
      }),
    }));
    expect(pills(markup)).toBe(1);
    expect(markup).toContain('<span aria-hidden="true">65</span>');
    expect(markup).toContain('<span class="sr-only">, 65 waiting</span>');
    expect(markup).toContain('title="65 dossiers to review — 41 final decision · 30 documents to check; a dossier can be in several"');
    // The pill sits inside the Clients link, after its label.
    const clients = markup.slice(markup.indexOf('href="/admin/clients"'), markup.indexOf('href="/admin/otc"'));
    expect(clients).toMatch(/clients<\/span><span title=/);
  });

  it("caps at 99+ and turns translucent on the active row", () => {
    nav.path = "/admin/kyc";
    const markup = html(createElement(AdminNav, {
      items: items({ "/admin/kyc": badgeView("/admin/kyc", { count: 250, parts: { new: 250 } }) }),
    }));
    expect(markup).toContain('<span aria-hidden="true">99+</span>');
    expect(markup).toContain("bg-white/20 text-white");
    expect(markup).not.toContain("bg-amber-100");
  });

  it("an unavailable count is a muted dot, a new row adds the dot marker", () => {
    nav.path = "/admin";
    const markup = html(createElement(AdminNav, {
      items: items({
        "/admin/issuers": badgeView("/admin/issuers", { count: null, reason: "indexer" }),
        "/admin/kyc": badgeView("/admin/kyc", { count: 3 }, { fresh: true }),
      }),
    }));
    expect(pills(markup)).toBe(2);
    expect(markup).toContain('<span aria-hidden="true">•</span>');
    expect(markup).toContain("bg-slate-100 text-slate-400");
    expect(markup).toContain("count unavailable");
    expect(markup).toContain('data-admin-badge-new=""');
    expect(markup).toContain("3 waiting, new since your last visit");
  });

  it("the pill alone", () => {
    const markup = html(createElement(AdminBadgePill, { view: badgeView("/admin/otc", { count: 2 })! }));
    expect(markup).toContain("bg-amber-100 text-amber-800");
    expect(markup).toContain('title="2 OTC requests waiting for an escrow deal"');
  });
});

describe("collapsed menu toggle", () => {
  const snapshot = (badges: typeof EMPTY_BADGES_SNAPSHOT.badges) => ({ ...EMPTY_BADGES_SNAPSHOT, key: "devnet|W", badges });
  const admin = new Set<Capability>(["admin"]);

  function toggle(value: ReturnType<typeof badgeMenu>) {
    nav.path = "/admin";
    return html(createElement(AdminBadgesContext.Provider, { value },
      createElement(AdminNavigation, null, createElement("span", null, "items"))));
  }

  it("shows the total of the visible counts", () => {
    const markup = toggle(badgeMenu(snapshot({ "/admin/otc": { count: 2 }, "/admin/clients": { count: 65 }, "/admin/issuers": { count: 4 } }), admin));
    // Issuers is super-admin only: 2 + 65.
    expect(markup).toContain('<span aria-hidden="true">67</span>');
    expect(markup).toContain("67 waiting");
    expect(markup.indexOf("Administration pages")).toBeLessThan(markup.indexOf("data-admin-badge"));
  });

  it("caps the total and hides it when nothing waits", () => {
    expect(toggle(badgeMenu(snapshot({ "/admin/otc": { count: 80 }, "/admin/clients": { count: 65 } }), admin)))
      .toContain('<span aria-hidden="true">99+</span>');
    expect(pills(toggle(badgeMenu(snapshot({ "/admin/otc": { count: 0 }, "/admin/governance": { count: null } }), admin)))).toBe(0);
  });
});
