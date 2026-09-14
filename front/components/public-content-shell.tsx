"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { DocumentationFrame } from "@/components/documentation-frame";
import { isDocumentationPath } from "@/lib/documentation";

/** Public guides and live market routes share the application workspace. */
export function PublicContentShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  if (isDocumentationPath(path)) return <AppShell section="documentation"><DocumentationFrame>{children}</DocumentationFrame></AppShell>;
  return <AppShell section={path === "/apply" ? "application" : "marketplace"}>{children}</AppShell>;
}
