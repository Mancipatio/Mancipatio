"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Item = { href: string; label: string };

const NAV: Item[] = [
  { href: "/portfolio", label: "Holdings" },
  { href: "/portfolio/offers", label: "OTC offers" },
  { href: "/portfolio/deals", label: "Deals" },
  { href: "/portfolio/listings", label: "Sell listings" },
  { href: "/portfolio/governance", label: "Governance" },
  { href: "/portfolio/rights", label: "Rights claims" },
  { href: "/portfolio/vesting", label: "Vesting" },
  { href: "/portfolio/delivery", label: "Delivery" },
  { href: "/portfolio/conversion", label: "Conversion" },
  { href: "/portfolio/history", label: "Activity" },
];

export function PortfolioNav() {
  const path = usePathname();
  return (
    <>
      {NAV.map((item) => {
        const active =
          item.href === "/portfolio"
            ? path === "/portfolio"
            : path === item.href || path.startsWith(item.href + "/");
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`block rounded-md px-3 py-1.5 text-sm transition-colors ${
              active
                ? "bg-slate-200 font-medium text-slate-900"
                : "text-slate-600 hover:bg-slate-200 hover:text-slate-900"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </>
  );
}
