import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { AccountRoles } from "@/components/account-roles";

export const metadata: Metadata = {
  title: "On-chain roles · Manci",
  description: "Your on-chain operator roles, the roles waiting for your acceptance and your open proposals.",
};

// Outside the admin gate on purpose (Talas 3.1 §4, OD4): the wallet that
// accepts a role holds no Admin record yet, and an operator without one
// (KYC provider, blocklist authority) hands its role over here.
export default function AccountRolesPage() {
  return (
    <AppShell section="account">
      <AccountRoles />
    </AppShell>
  );
}
