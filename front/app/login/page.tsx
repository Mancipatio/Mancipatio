import type { Metadata } from "next";
import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { SignIn } from "@/components/sign-in";

export const metadata: Metadata = {
  title: "Sign in · Manci",
  description: "Sign in to Manci with your email or Google. No wallet needed to get started.",
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
