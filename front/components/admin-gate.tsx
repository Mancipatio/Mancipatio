"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { RequireRole } from "@/components/require-role";
import { useRole } from "@/lib/auth";
import { adminRouteRequirement } from "@/lib/role-resolution";

/**
 * The gate of the whole /admin area (app/admin/layout.tsx). Default deny: the
 * current path opens only for the capabilities its entry in
 * ADMIN_ROUTE_ACCESS lists (whole path segments), and every unlisted path is
 * admin-only. Pages keep their own gates, and every server route and builder
 * re-checks on-chain state — this is a hint, not the enforcement.
 */
export function AdminGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // The navigation filters by every capability, so resolve the KYC role too.
  useRole({ kyc: true });
  return <RequireRole anyOf={adminRouteRequirement(pathname)}>{children}</RequireRole>;
}
