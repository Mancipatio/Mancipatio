"use client";

import type { ReactNode } from "react";
import { useRole } from "@/lib/auth";
import { adminRouteAllows, type Capability } from "@/lib/role-resolution";
import { AdminNav } from "./admin-nav";

export type AdminNavItem = {
  href: string;
  label: string;
  icon: ReactNode;
  /** Who may open the page: its ADMIN_ROUTE_ACCESS requirement. */
  roles: readonly Capability[];
};

export type AdminNavGroup = { label: string | null; items: AdminNavItem[] };

/**
 * The admin menu, filtered to the pages the connected wallet may open
 * (the same table as the AdminGate) — an operator role sees only its own
 * pages, and a group with no visible page is hidden.
 */
export function AdminNavGroups({ groups }: { groups: AdminNavGroup[] }) {
  const { capabilities } = useRole({ kyc: true });
  return (
    <>
      {groups.map((group, index) => {
        const items = group.items.filter((item) => adminRouteAllows(item.href, capabilities));
        if (items.length === 0) return null;
        return (
          <div key={group.label ?? `group-${index}`} className="app-admin-nav-group">
            {group.label && <p>{group.label}</p>}
            <AdminNav items={items} />
          </div>
        );
      })}
    </>
  );
}
