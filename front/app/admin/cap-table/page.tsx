import { RequireRole } from "@/components/require-role";
import { CapTableAdmin } from "./cap-table-admin";

export default function CapTablePage() {
  return (
    <section className="min-w-0 flex-1">
      <p className="page-eyebrow">On-chain</p>
      <h1 className="page-title">Cap table</h1>
      <p className="page-sub">
        Reconcile each share class on chain with the company register: supply, custody, holders and
        the units burned through conversions next to the recorded registry decisions. Record the
        register entry after the registry decision, and export the reconciliation for the
        accountant and counsel.
      </p>
      <RequireRole role="admin">
        <div className="mt-7"><CapTableAdmin /></div>
      </RequireRole>
    </section>
  );
}
