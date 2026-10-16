import { RequireRole } from "@/components/require-role";
import { AccountsPanel } from "./accounts-panel";

export default function AccountsPage() {
  return <section className="min-w-0 flex-1">
    <p className="page-eyebrow">People</p>
    <h1 className="page-title">Platform accounts</h1>
    <p className="page-sub">Everyone with a registered account, including people who have not started KYC or KYB.</p>
    <RequireRole role="admin"><div className="mt-8"><AccountsPanel /></div></RequireRole>
  </section>;
}
