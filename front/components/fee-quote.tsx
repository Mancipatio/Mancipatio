"use client";

// <FeeQuote kind="conversion" /> — the published Manci fee of a step, shown
// next to its form before the client commits. Read-only and informational:
// nothing is charged here (collection is by invoice, off-chain, migration
// 0089), and the form works the same with or without it.
//
// Self-contained so a page adopts it with one import and one line: it reads
// GET /api/fees/public (lib/fees/client.ts, one request per page load) and
//   * renders NOTHING while no fee of the kind is published, so the form
//     looks exactly as before until an admin publishes a price;
//   * says so and points to /pricing when the read fails, rather than
//     staying silent (a client must not mistake an outage for "no fee");
//   * otherwise shows the amount (describeFee, the same text as /pricing),
//     who pays, when it is invoiced and the row's public note, and, when the
//     caller passes `baseEur` (and `quantity` for a per-unit fee), an
//     estimate from quoteFee, the function the charge itself is priced with.

import Link from "next/link";
import { useEffect, useState } from "react";
import { describeFee, formatEurCents, formatFeeDate, lowerFirst, quoteFee } from "@/lib/fees/quote";
import { FEE_KIND_INVOICED_WHEN, FEE_PAYER_LABEL, type FeeKind, type PublicFee } from "@/lib/fees/schedule";
import { fetchPublishedFees } from "@/lib/fees/client";

/** `checkedAt`: when the fees were read, what "applies from" is judged against (not the render time). */
export type FeeQuoteState = { phase: "loading" } | { phase: "ready"; fees: PublicFee[]; checkedAt: number } | { phase: "failed" };

type FeeQuoteProps = {
  kind: FeeKind;
  /** The EUR value the rate applies to, when the page knows it. */
  baseEur?: number | string;
  /** Units of a per-unit fee (migration_per_holder). */
  quantity?: number;
  className?: string;
};

/** The estimate line, or null when the inputs cannot be priced (never a guess). */
function estimate(fee: PublicFee, baseEur: number | string | undefined, quantity: number | undefined): string | null {
  if (baseEur === undefined && quantity === undefined) return null;
  try {
    return formatEurCents(quoteFee(fee, baseEur ?? 0, quantity ?? 1).cents);
  } catch {
    return null;
  }
}

/** What FeeQuote renders for a given read state (pure). */
export function FeeQuoteView({
  state,
  kind,
  baseEur,
  quantity,
  className = "",
}: FeeQuoteProps & { state: FeeQuoteState }) {
  if (state.phase === "loading") return null;
  const box = `rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] leading-relaxed text-slate-600 ${className}`;
  if (state.phase === "failed") {
    return (
      <p className={box} role="status" data-fee-quote={kind}>
        The published fee for this step could not be loaded.{" "}
        <Link href="/pricing" className="underline underline-offset-2">
          See pricing
        </Link>{" "}
        before you continue.
      </p>
    );
  }
  const fee = state.fees.find((row) => row.kind === kind);
  if (!fee) return null;
  const upcoming = Date.parse(fee.effective_from) > state.checkedAt;
  const estimated = estimate(fee, baseEur, quantity);
  return (
    <div className={box} data-fee-quote={kind}>
      <p>
        <span className="font-medium text-slate-800">Manci fee:</span> {describeFee(fee)}
        {upcoming ? ` (from ${formatFeeDate(fee.effective_from)})` : ""}.
      </p>
      <p>
        Paid by the {FEE_PAYER_LABEL[fee.payer].toLowerCase()}, invoiced in euros{" "}
        {lowerFirst(FEE_KIND_INVOICED_WHEN[kind])}; nothing is charged on-chain.
      </p>
      {fee.public_note ? <p>{fee.public_note}</p> : null}
      {estimated ? <p>Estimated fee: {estimated}.</p> : null}
      <p>
        <Link href="/pricing" className="underline underline-offset-2">
          Pricing
        </Link>
      </p>
    </div>
  );
}

export function FeeQuote(props: FeeQuoteProps) {
  const [state, setState] = useState<FeeQuoteState>({ phase: "loading" });

  useEffect(() => {
    let live = true;
    fetchPublishedFees().then(
      (fees) => {
        if (live) setState({ phase: "ready", fees, checkedAt: Date.now() });
      },
      () => {
        if (live) setState({ phase: "failed" });
      },
    );
    return () => {
      live = false;
    };
  }, []);

  return <FeeQuoteView {...props} state={state} />;
}
