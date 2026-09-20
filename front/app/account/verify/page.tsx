import type { Metadata } from "next";
import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { AccountEmailVerification } from "@/components/account-email-verification";

export const metadata: Metadata = {
  title: "Confirm your email · Manci",
  referrer: "no-referrer",
};

export default function VerifyAccountEmailPage() {
  return (
    <AppShell section="account">
      <Suspense fallback={<p className="account-loading" role="status">Loading email confirmation…</p>}>
        <AccountEmailVerification />
      </Suspense>
    </AppShell>
  );
}
