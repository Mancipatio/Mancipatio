"use client";

// The direct way to where Primary issuance (0x02) is reopened
// (lib/distribute-guidance primaryReopenPlace), next to every Distribute
// note that says only the super admin can reopen it.

import Link from "next/link";
import { primaryReopenPlace } from "@/lib/distribute-guidance";

export function PrimaryReopenLink({ publicSale, className }: { publicSale: boolean; className?: string }) {
  const place = primaryReopenPlace({ publicSale });
  return (
    <Link
      href={place.href}
      data-reopen-link=""
      className={`inline-flex items-center gap-1 rounded-md border border-amber-300 bg-white px-2 py-0.5 text-[12px] font-medium text-amber-900 hover:border-amber-400 ${className ?? ""}`}
    >
      {place.label} →
    </Link>
  );
}
