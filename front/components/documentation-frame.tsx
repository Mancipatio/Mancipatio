"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { DOCUMENTATION_GROUPS, documentationTopic } from "@/lib/documentation";
import { IconFile, IconArrowUpRight } from "@/components/icons";
import { navHrefVisible } from "@/lib/pilot-scope";

export function DocumentationFrame({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const topic = documentationTopic(path);
  const currentHref = topic?.href ?? "/docs";
  // Pilot scope (lib/pilot-scope.ts navHrefVisible, as documentation-index.tsx):
  // no guide of a switched-off module or of what KYC-only mode pauses, except
  // the page being read; a group left empty goes.
  const groups = DOCUMENTATION_GROUPS
    .map((group) => ({ ...group, topics: group.topics.filter((item) => item.href === currentHref || navHrefVisible(item.href)) }))
    .filter((group) => group.topics.length > 0);
  return <div className="docs-layout">
    <aside className="docs-navigation">
      <Link href="/docs" className="docs-nav-brand"><span><IconFile size={19} /></span><div><strong>Documentation</strong><small>Guides & reference</small></div></Link>
      <nav aria-label="Documentation topics">
        <Link href="/docs" className={`docs-nav-overview ${path === "/docs" ? "is-current" : ""}`} aria-current={path === "/docs" ? "page" : undefined}>Overview <span aria-hidden="true">↗</span></Link>
        {groups.map((group) => <div className="docs-nav-group" key={group.id}><p>{group.title}</p>{group.topics.map((item) => <Link key={item.href} href={item.href} className={currentHref === item.href ? "is-current" : ""} aria-current={path === item.href ? "page" : currentHref === item.href ? "location" : undefined}>{item.title}</Link>)}</div>)}
      </nav>
    </aside>
    <div className="docs-main">
      <label className="docs-mobile-navigation">Documentation<select aria-label="Documentation page" value={currentHref} onChange={(event) => router.push(event.target.value)}><option value="/docs">Overview</option>{groups.map((group) => <optgroup label={group.title} key={group.id}>{group.topics.map((item) => <option value={item.href} key={item.href}>{item.title}</option>)}</optgroup>)}</select></label>
      <div className="docs-breadcrumb"><Link href="/docs">Documentation</Link><span aria-hidden="true">/</span><span>{topic?.title ?? "Overview"}</span></div>
      <div className="docs-article" data-mx>{children}</div>
      <div className="docs-help"><span>Need help with a specific asset or workflow?</span><Link href="/contact">Contact the team <IconArrowUpRight size={14} /></Link></div>
    </div>
  </div>;
}
