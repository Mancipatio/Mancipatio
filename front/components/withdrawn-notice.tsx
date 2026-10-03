"use client";

// What a direct link to an archived asset or issuer shows (lib/archive.ts):
// a 404-like page that says it was withdrawn, not a broken page.

import Link from "next/link";
import { WITHDRAWN_BODY, WITHDRAWN_ISSUER_TITLE, WITHDRAWN_TITLE } from "@/lib/archive";

export function WithdrawnNotice({ kind = "asset", address }: { kind?: "asset" | "issuer"; address?: string }) {
  return (
    <section>
      <p className="text-xs font-semibold uppercase tracking-widest text-mx-ink-faint">
        {kind === "asset" ? "Asset" : "Issuer"}
      </p>
      <h1 className="mt-1 text-2xl font-semibold text-mx-ink">
        {kind === "asset" ? WITHDRAWN_TITLE : WITHDRAWN_ISSUER_TITLE}
      </h1>
      <p className="mt-2 max-w-xl text-sm text-mx-ink-soft">{WITHDRAWN_BODY}</p>
      {address && <p className="mt-2 break-all font-mono text-[11px] text-mx-ink-faint">{address}</p>}
      <div className="mt-4 flex flex-wrap gap-4 text-sm">
        <Link href="/marketplace" className="text-mx-ink-soft underline-offset-2 hover:underline">
          ← Back to marketplace
        </Link>
        <Link href="/portfolio" className="text-mx-ink-soft underline-offset-2 hover:underline">
          My portfolio
        </Link>
      </div>
    </section>
  );
}
