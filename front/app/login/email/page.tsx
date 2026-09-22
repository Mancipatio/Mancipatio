import type { Metadata } from "next";
import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { EmailSignInLanding } from "@/components/sign-in";

export const metadata: Metadata = { title: "Signing in · Manci", robots: { index: false } };

export default function EmailSignInPage() {
  return (
    <AppShell section="account">
      <Suspense fallback={<p className="account-loading" role="status">Signing you in…</p>}>
        <EmailSignInLanding />
      </Suspense>
    </AppShell>
  );
}
