"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AdminBadgePill } from "@/components/admin-badge-pill";
import type { BadgeView } from "@/lib/admin-badges";

type Item = {
  href: string;
  label: string;
  icon?: ReactNode;
  /** What waits for the viewer on this page (hidden at 0; AdminBadgesProvider). */
  badge?: BadgeView | null;
};

export function AdminNav({ items }: { items: Item[] }) {
  const path = usePathname();
  return (
    <>
      {items.map((item) => {
        const active =
          item.href === "/admin"
            ? path === "/admin"
            : path === item.href || path.startsWith(item.href + "/");
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] leading-snug transition-colors ${
              active
                ? "bg-brand-600 font-medium text-white shadow-sm"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            }`}
          >
            {item.icon && (
              <span
                className={`flex h-4 w-4 shrink-0 items-center justify-center ${
                  active ? "text-white" : "text-slate-400"
                }`}
              >
                {item.icon}
              </span>
            )}
            <span className="truncate">{item.label}</span>
            {item.badge && <AdminBadgePill view={item.badge} active={active} />}
          </Link>
        );
      })}
    </>
  );
}
