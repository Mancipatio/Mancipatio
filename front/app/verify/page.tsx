import type { Metadata } from "next";
import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { VerificationForm } from "@/components/verification-form";

export const metadata: Metadata = {
  title: "Verification · Manci",
  description: "Verify your identity (KYC) to convert tokens into company shares or take delivery, or your company (KYB) to raise and issue on Manci.",
};

export default function VerifyPage() {
  return (
    <AppShell section="account">
      <Suspense fallback={<p className="account-loading" role="status">Loading verification…</p>}>
        <VerificationForm />
      </Suspense>
    </AppShell>
  );
}
