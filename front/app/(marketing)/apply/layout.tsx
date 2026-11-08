import type { Metadata } from "next";
import { indexingAllowed } from "@/lib/indexing";
import { navHrefVisible } from "@/lib/pilot-scope";

// /apply is a client page, so its title and description live here. While
// issuance is not offered on this network (KYC-only mode pauses it:
// lib/pilot-scope.ts KYC_ONLY_ROUTES) the page shows the notice instead of the
// form, and the description says so; where the build allows indexing it is
// then noindex, like the guide of a switched-off module. (Elsewhere the root
// layout's stricter policy stays: lib/indexing.ts.)
const offered = navHrefVisible("/apply");

export const metadata: Metadata = {
  title: "Apply to issue · Manci",
  description: offered
    ? "Apply to issue company shares on Manci. A person reads every application and replies either way."
    : "Applications to issue are not available at the moment.",
  ...(!offered && indexingAllowed() ? { robots: { index: false, follow: true } } : {}),
};

export default function ApplyLayout({ children }: { children: React.ReactNode }) {
  return children;
}
