import Link from "next/link";
import { detectNetwork, isTestNetwork } from "@/lib/network";

export const metadata = {
  title: "Not found — Manci",
};

export default function NotFound() {
  const network = detectNetwork();
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-24">
      <div className="max-w-md text-center">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-slate-500">
          404
        </p>
        <h1 className="mt-3 text-3xl font-semibold text-slate-900">
          Nothing here
        </h1>
        <p className="mt-3 text-sm text-slate-600">
          The page you were looking for doesn&apos;t exist
          {isTestNetwork(network) ? ` on this ${network} deployment` : ""}. Try
          one of the links below.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3 text-sm">
          <Link
            href="/"
            className="rounded-lg bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-800"
          >
            Home
          </Link>
          <Link
            href="/marketplace"
            className="rounded-lg border border-slate-300 px-4 py-2 text-slate-700 hover:border-slate-400"
          >
            Marketplace
          </Link>
          <Link
            href="/issuer/onboarding"
            className="rounded-lg border border-slate-300 px-4 py-2 text-slate-700 hover:border-slate-400"
          >
            Become an issuer
          </Link>
        </div>
      </div>
    </main>
  );
}
