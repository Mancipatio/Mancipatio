"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { features } from "@/lib/features";

type Item = { href: string; label: string };

const NAV: Item[] = [
  { href: "/issuer", label: "Overview" },
  { href: "/issuer/assets", label: "My assets" },
  { href: "/issuer/share-classes", label: "My share classes" },
  { href: "/issuer/launchpad", label: "My sales" },
  { href: "/issuer/payouts", label: "Payout vaults" },
  { href: "/issuer/vesting", label: "Vesting" },
  { href: "/issuer/vesting-series", label: "Vesting series" },
  ...(features().issuerRotation ? [{ href: "/issuer/rotation", label: "Authority key" }] : []),
];

export function IssuerNav() {
  const path = usePathname();
  return (
    <>
      {NAV.map((item) => {
        const active =
          item.href === "/issuer"
            ? path === "/issuer"
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
