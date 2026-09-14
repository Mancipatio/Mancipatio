"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/mx";

const NAV = [
  { href: "/marketplace", label: "Discover" },
  { href: "/marketplace/launchpad", label: "Launchpad" },
  { href: "/marketplace/otc", label: "OTC" },
  { href: "/marketplace/governance", label: "Governance" },
];

export function MarketplaceNav() {
  const path = usePathname();
  return (
    <nav className="flex gap-1 text-sm">
      {NAV.map((item) => {
        const active =
          item.href === "/marketplace"
            ? path === "/marketplace"
            : path.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cx(
              "rounded-[3px] px-3 py-1.5 transition-colors",
              active
                ? "bg-mx-ink font-medium text-mx-paper"
                : "text-mx-ink-soft hover:bg-mx-indigo-soft hover:text-mx-ink",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
