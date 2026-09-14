"use client";

import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";

export function AdminNavigation({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [previousPath, setPreviousPath] = useState(path);
  const [expanded, setExpanded] = useState(false);
  if (path !== previousPath) {
    setPreviousPath(path);
    setExpanded(false);
  }
  return <aside className="app-admin-menu">
    <button type="button" className="app-admin-toggle" aria-expanded={expanded} aria-controls="admin-page-navigation" onClick={() => setExpanded(!expanded)}>
      Administration pages <span aria-hidden="true">{expanded ? "−" : "+"}</span>
    </button>
    <nav id="admin-page-navigation" aria-label="Administration pages" className={expanded ? "is-open" : ""}>{children}</nav>
  </aside>;
}
