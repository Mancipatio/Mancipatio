import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { DocumentationFrame } from "@/components/documentation-frame";
import { DocumentationIndex } from "@/components/documentation-index";
import { navHrefVisible } from "@/lib/pilot-scope";

// Only the guides this network lists (lib/documentation.ts hides the guides
// of switched-off modules).
const moduleGuides = [
  ...(navHrefVisible("/solutions/otc") ? ["trading"] : []),
  ...(navHrefVisible("/solutions/rights-vesting") ? ["vesting"] : []),
];

export const metadata: Metadata = {
  title: "Documentation · Manci",
  description: `Guides to Manci assets, issuance, ${moduleGuides.map((guide) => `${guide}, `).join("")}controls and issuer disclosures.`,
};

export default function DocumentationPage() {
  return <AppShell section="documentation"><DocumentationFrame><DocumentationIndex /></DocumentationFrame></AppShell>;
}
