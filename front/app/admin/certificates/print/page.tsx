import { Suspense } from "react";
import { RequireRole } from "@/components/require-role";
import { CertificatePrintView } from "./print-view";

// The printable certificate (admin only: a payload may carry the holder's
// name and ID number). The id comes from the query string, read on the
// client (useSearchParams), hence the Suspense boundary.
export default function CertificatePrintPage() {
  return (
    <section className="min-w-0 flex-1">
      <RequireRole role="admin">
        <Suspense fallback={<p role="status" className="panel panel-pad text-sm text-slate-500">Loading the certificate…</p>}>
          <CertificatePrintView />
        </Suspense>
      </RequireRole>
    </section>
  );
}
