import type { Metadata } from "next";
import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { SignIn } from "@/components/sign-in";

export const metadata: Metadata = {
  title: "Sign in · Manci",
  description: "Sign in to Manci with email, Google or a wallet. No wallet needed for email or Google sign-in.",
};

export default function LoginPage() {
  return (
    <AppShell section="account">
      <Suspense fallback={<p className="account-loading" role="status">Loading…</p>}>
        <SignIn />
      </Suspense>
    </AppShell>
  );
}
