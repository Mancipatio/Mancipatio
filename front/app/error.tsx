"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface unexpected errors in browser/server logs.
    console.error("[manci:error]", error);
  }, [error]);

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-24">
      <div className="max-w-md text-center">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-red-600">
          Error
        </p>
        <h1 className="mt-3 text-3xl font-semibold text-slate-900">
          Something went wrong
        </h1>
        <p className="mt-3 text-sm text-slate-600">
          {error.message || "An unexpected error occurred. Try again, or head back to the marketplace."}
        </p>
        {error.digest && (
          <p className="mt-2 font-mono text-[11px] text-slate-400">
            Ref: {error.digest}
          </p>
        )}
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3 text-sm">
          <button
            type="button"
            onClick={reset}
            className="rounded-lg bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-800"
          >
            Try again
          </button>
          <Link
            href="/"
            className="rounded-lg border border-slate-300 px-4 py-2 text-slate-700 hover:border-slate-400"
          >
            Home
          </Link>
        </div>
      </div>
    </main>
  );
}
