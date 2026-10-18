"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navHrefVisible } from "@/lib/pilot-scope";
import { ISSUER_WORKFLOW_TABS } from "@/lib/issuer-workflow";

type Item = { href: string; label: string };

const NAV: Item[] = ISSUER_WORKFLOW_TABS.map(([href, label]) => ({ href, label }));

export function IssuerNav() {
  const path = usePathname();
  return (
    <>
      {NAV.filter((item) => navHrefVisible(item.href)).map((item) => {
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
