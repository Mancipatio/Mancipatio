"use client";

// The printable view of one certificate (/admin/certificates/print?id=…):
// the sheet (../certificate-sheet.tsx) and a "Print or save as PDF" button.
// The browser prints the sheet alone (CERTIFICATE_PRINT_CSS) and takes the
// page title, set here to the certificate's number, as the PDF's file name.
// The data is the admin detail route's (signed session read): a payload may
// carry the holder's name and ID number, so it is never cached or shared.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { WalletSession } from "@solana/client";
import { useWalletConnection } from "@solana/react-hooks";
import { readCertificate } from "@/lib/certificates-client";
import { certificateVerifyPath, type CertificateDetail } from "@/lib/certificates/payload";
import { CERTIFICATE_ID_PATTERN } from "@/lib/certificates/routes";
import { WalletSessionRequiredError, type SignedFetchInteractive } from "@/lib/siws-client";
import { detectNetwork } from "@/lib/network";
import { CERTIFICATE_PRINT_CSS, CertificateSheet } from "../certificate-sheet";

type Load = { state: "loading" } | { state: "signin" } | { state: "error"; text: string } | { state: "ready"; detail: CertificateDetail };

export function CertificatePrintView() {
  const id = useSearchParams().get("id") ?? "";
  const { wallet } = useWalletConnection();
  if (!wallet) return null;
  if (!CERTIFICATE_ID_PATTERN.test(id)) {
    return <p className="panel panel-pad text-sm text-slate-600">Open a certificate from the certificates page to print it.</p>;
  }
  return <PrintBody key={`${detectNetwork()}:${wallet.account.address}:${id}`} session={wallet} id={id} />;
}

/** The public verification URL printed on the certificate (the site's canonical origin when the build has one). */
function verifyUrlFor(number: string): string {
  const origin = process.env.NEXT_PUBLIC_SITE_URL || window.location.origin;
  try {
    return new URL(certificateVerifyPath(number), origin).toString();
  } catch {
    return `${window.location.origin}${certificateVerifyPath(number)}`;
  }
}

function PrintBody({ session, id }: { session: WalletSession; id: string }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });

  const fetchDetail = useCallback(
    async (interactive: SignedFetchInteractive) => {
      try {
        setLoad({ state: "ready", detail: await readCertificate(session, id, interactive) });
      } catch (err) {
        setLoad(err instanceof WalletSessionRequiredError ? { state: "signin" } : { state: "error", text: err instanceof Error ? err.message : String(err) });
      }
    },
    [session, id],
  );

  useEffect(() => {
    let cancelled = false;
    // An existing wallet session only: opening the page never prompts.
    void readCertificate(session, id, false).then(
      (detail) => {
        if (!cancelled) setLoad({ state: "ready", detail });
      },
      (err) => {
        if (cancelled) return;
        setLoad(err instanceof WalletSessionRequiredError ? { state: "signin" } : { state: "error", text: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [session, id]);

  const number = load.state === "ready" ? load.detail.number : null;
  useEffect(() => {
    if (!number) return;
    const previous = document.title;
    document.title = `${number} · Manci certificate`;
    return () => {
      document.title = previous;
    };
  }, [number]);
  const verifyUrl = useMemo(() => (number ? verifyUrlFor(number) : ""), [number]);

  if (load.state === "loading") return <p role="status" className="panel panel-pad text-sm text-slate-500">Loading the certificate…</p>;
  if (load.state === "signin") {
    return (
      <div className="panel panel-pad text-sm text-slate-600">
        <p>The certificate needs a wallet sign-in (one message, no transaction).</p>
        <button type="button" className="btn-brand mt-3" onClick={() => void fetchDetail("session-only")}>
          Sign in and load
        </button>
      </div>
    );
  }
  if (load.state === "error") {
    return (
      <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        <p>{load.text}</p>
        <button type="button" className="btn-ghost mt-3" onClick={() => void fetchDetail(true)}>
          Try again
        </button>
      </div>
    );
  }

  const { detail } = load;
  return (
    <div className="space-y-4">
      <style>{CERTIFICATE_PRINT_CSS}</style>
      <div className="certificate-no-print flex flex-wrap items-center justify-between gap-3">
        <Link href="/admin/certificates" className="text-sm font-medium text-slate-700 underline hover:text-slate-900">
          ← Certificates
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          {detail.status === "draft" && (
            <span className="text-xs text-amber-800">A draft is not a certificate: it prints marked as such until it is signed.</span>
          )}
          <button type="button" className="btn-brand" onClick={() => window.print()}>
            Print or save as PDF
          </button>
        </div>
      </div>
      <CertificateSheet detail={detail} verifyUrl={verifyUrl} />
    </div>
  );
}
