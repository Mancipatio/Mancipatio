"use client";

import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { AdminBadgePill } from "@/components/admin-badge-pill";
import { useAdminBadges } from "@/components/admin-badges-context";

export function AdminNavigation({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [previousPath, setPreviousPath] = useState(path);
  const [expanded, setExpanded] = useState(false);
  // The sum of the item counts, so a collapsed menu (≤1100px) still says
  // that something waits; the opened grid shows the per-item pills.
  const { total } = useAdminBadges();
  if (path !== previousPath) {
    setPreviousPath(path);
    setExpanded(false);
  }
  return <aside className="app-admin-menu">
    <button type="button" className="app-admin-toggle" aria-expanded={expanded} aria-controls="admin-page-navigation" onClick={() => setExpanded(!expanded)}>
      <span className="flex items-center gap-2">Administration pages{total && <AdminBadgePill view={total} />}</span>
      <span aria-hidden="true">{expanded ? "−" : "+"}</span>
    </button>
    <nav id="admin-page-navigation" aria-label="Administration pages" className={expanded ? "is-open" : ""}>{children}</nav>
  </aside>;
}
