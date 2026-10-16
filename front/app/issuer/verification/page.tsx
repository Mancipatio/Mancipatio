import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { VerificationForm } from "@/components/verification-form";

export default async function IssuerVerificationPage({ searchParams }: {
  searchParams: Promise<{ type?: string; next?: string }>;
}) {
  const query = await searchParams;
  // The shared form uses this destination to request founder KYC, rather
  // than the investor-passport document set, for an individual issuer.
  if (query.next !== "/apply") {
    redirect(`/issuer/verification?type=${query.type === "kyb" ? "kyb" : "kyc"}&next=/apply`);
  }
  return <main className="min-w-0 flex-1">
    <p className="mb-5 text-xs text-slate-500"><Link href="/issuer">Issuer process</Link> / 1. KYC / KYB · <Link href="/issuer/status" className="underline underline-offset-2">Review status</Link></p>
    <Suspense fallback={<p role="status">Loading verification…</p>}><VerificationForm context="issuer" /></Suspense>
  </main>;
}
