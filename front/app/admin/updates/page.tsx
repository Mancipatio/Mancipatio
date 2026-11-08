import { RequireRole } from "@/components/require-role";
import { UpdatesModeration } from "./updates-moderation";

export default function IssuerUpdatesAdminPage() {
  return (
    <section className="min-w-0 flex-1">
      <p className="page-eyebrow">On-chain</p>
      <h1 className="page-title">Issuer updates</h1>
      <p className="page-sub">
        Updates, reports and notices issuers published for their holders. Withdraw one that must not stay published; the
        reason is kept with it and shown to its issuer.
      </p>
      <RequireRole role="admin">
        <div className="mt-7"><UpdatesModeration /></div>
      </RequireRole>
    </section>
  );
}
