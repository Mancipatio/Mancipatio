import Link from "next/link";
import { RequireRole } from "@/components/require-role";
import { CertificatesConsole } from "./certificates-console";

export default function CertificatesPage() {
  return (
    <section className="min-w-0 flex-1">
      <p className="page-eyebrow">Oversight</p>
      <h1 className="page-title">Certificates</h1>
      <p className="page-sub">
        Issue numbered certificates of tokenized interest for authorities and holders: a holding (the units a wallet holds)
        or an issuance (a share class as issued). The Super Admin creates and signs each one with the operator&apos;s key and
        anchors its hash on chain; any admin can preview, print, download and revoke; and whoever holds a certificate can
        check it on the{" "}
        <Link className="underline" href="/certificates/verify">
          public verification page
        </Link>
        .
      </p>
      <RequireRole role="admin">
        <div className="mt-7">
          <CertificatesConsole />
        </div>
      </RequireRole>
    </section>
  );
}
