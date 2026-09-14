import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { DocumentationFrame } from "@/components/documentation-frame";
import { DocumentationIndex } from "@/components/documentation-index";

export const metadata: Metadata = {
  title: "Documentation · Mancipatio",
  description: "Guides to Mancipatio assets, issuance, trading, vesting, controls and issuer disclosures.",
};

export default function DocumentationPage() {
  return <AppShell section="documentation"><DocumentationFrame><DocumentationIndex /></DocumentationFrame></AppShell>;
}
