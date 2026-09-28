"use client";

// The D1 proceeds-freeze badge on the issuer, launchpad, payout and rights
// pages (design 8.3 §3): what the freeze closes on this page, and that money
// already paid in stays in escrow. The buttons it names are disabled by the
// page; the send path refuses them again before the wallet opens.
import { FROZEN_SALE_PAYMENTS_NOTE } from "@/lib/issuer-freeze";

export const PROCEEDS_FROZEN_BADGE = "Proceeds frozen";

export function ProceedsFrozenNotice({ closed, className = "" }: { closed: string; className?: string }) {
  return (
    <div role="status" className={`rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900 ${className}`}>
      <span className="mr-2 inline-flex rounded-full border border-red-200 bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-800">
        {PROCEEDS_FROZEN_BADGE}
      </span>
      Manci has frozen this issuer&apos;s proceeds: {closed} until the Super Admin lifts the freeze.{" "}
      {FROZEN_SALE_PAYMENTS_NOTE}
    </div>
  );
}
