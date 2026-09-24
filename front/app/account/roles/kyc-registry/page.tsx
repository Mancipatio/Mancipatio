import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { KycRegistryCreationFlow } from "@/components/kyc-registry-creation-flow";

export const metadata: Metadata = {
  title: "Create the KYC registry · Manci",
  description: "Create the platform KYC registry with a separate KYC authority and Admin co-signer.",
};

// Outside the admin gate (Talas 3.1 K5): the KYC authority that owns the new
// registry holds no Admin record. Both signers review the same typed terms.
export default function KycRegistryCreationPage() {
  return (
    <AppShell section="account">
      <KycRegistryCreationFlow />
    </AppShell>
  );
}
