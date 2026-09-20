import type { Metadata } from "next";
import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { AccountProfile } from "@/components/account-profile";

export const metadata: Metadata = {
  title: "Your account · Manci",
  description: "Manage your wallet profile, contact email and connected Google account.",
};

export default function AccountPage() {
  return (
    <AppShell section="account">
      <Suspense fallback={<p className="account-loading" role="status">Loading your account…</p>}>
        <AccountProfile />
      </Suspense>
    </AppShell>
  );
}
