import { Suspense } from "react";
import Link from "next/link";
import { VerificationForm } from "@/components/verification-form";

export default function IssuerVerificationPage() {
  return <main className="min-w-0 flex-1">
    <p className="mb-5 text-xs text-slate-500"><Link href="/issuer">Issuer process</Link> / 1. KYC / KYB · <Link href="/issuer/status" className="underline underline-offset-2">Review status</Link></p>
    <Suspense fallback={<p role="status">Loading verification…</p>}><VerificationForm /></Suspense>
  </main>;
}
