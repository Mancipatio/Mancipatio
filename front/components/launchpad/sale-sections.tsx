"use client";

// The launchpad sale page's layout and its legal blocks (lib/sale-page):
//   SalePageLayout       header → buy card → main column, in DOM order (the
//                        phone order); on a wide screen the buy card is a
//                        sticky right column beside the header and main.
//   SaleDocumentsSection the full Investment documents block (status line,
//                        document link, SHA-256 fingerprint) — main column.
//   SaleRiskWarningSection the full risk warning — main column.
//   SaleAcceptances      the two checkboxes the Buy button waits for, in the
//                        buy card directly above it, each with a link to the
//                        full text. Their wording is the legal copy, unchanged.
//   SoldProgress         the compact "Sold" progress of an on-chain sale.

import type { ReactNode } from "react";
import { PurchaseRiskWarning } from "@/components/legal/purchase-risk-warning";
import type { SaleDocumentTerms } from "@/lib/document-terms";
import { PURCHASE_RISK_WARNING } from "@/lib/legal/risk-warning";
import { SALE_DOCUMENTS_ANCHOR, SALE_RISK_WARNING_ANCHOR, SOLD_LABEL, soldProgress } from "@/lib/sale-page";
import { SSC_NOT_APPROVED_LABEL } from "@/lib/whitepaper-approval";

export function SalePageLayout({ header, buy, main }: { header: ReactNode; buy: ReactNode; main: ReactNode }) {
  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:grid-rows-[auto_1fr] lg:gap-x-8 lg:gap-y-6">
      <div data-sale-region="header" className="min-w-0 lg:col-start-1 lg:row-start-1">
        {header}
      </div>
      <aside
        data-sale-region="buy"
        aria-label="Buy"
        className="min-w-0 space-y-4 self-start lg:sticky lg:top-20 lg:col-start-2 lg:row-span-2 lg:row-start-1"
      >
        {buy}
      </aside>
      <div data-sale-region="main" className="min-w-0 lg:col-start-1 lg:row-start-2">
        {main}
      </div>
    </div>
  );
}

/** The verified document's status line (ZDI art. 17(3)). */
function statusLine(terms: SaleDocumentTerms): string {
  return terms.sscDecisionRef
    ? `Status: approved by the Serbian Securities Commission (${terms.sscDecisionRef}).`
    : `Status: ${SSC_NOT_APPROVED_LABEL}.`;
}

/**
 * The full Investment documents block. `terms` only when they belong to this
 * sale (the page compares the served terms' sale with the page's); otherwise
 * the error, or that they are loading.
 */
export function SaleDocumentsSection({ terms, error }: { terms: SaleDocumentTerms | null; error: string | null }) {
  return (
    <section
      id={SALE_DOCUMENTS_ANCHOR}
      aria-labelledby={`${SALE_DOCUMENTS_ANCHOR}-title`}
      className="scroll-mt-24 rounded-[3px] border border-mx-rule bg-white p-4 text-sm"
    >
      <h2 id={`${SALE_DOCUMENTS_ANCHOR}-title`} className="font-semibold text-mx-ink">
        Investment documents
      </h2>
      {terms ? (
        <>
          {/* ZDI art. 17(3): during the offering, say clearly whether the
              whitepaper is approved. Approval needs the recorded decision
              reference; anything else is "not approved". "Verified" below is
              the file's fingerprint only. */}
          {terms.sscDecisionRef ? (
            <p className="mt-2 inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
              Approved by the Serbian Securities Commission · {terms.sscDecisionRef}
            </p>
          ) : (
            <p className="mt-2 inline-flex rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800">
              {SSC_NOT_APPROVED_LABEL}
            </p>
          )}
          <a className="mt-2 block underline" href={terms.url} target="_blank" rel="noreferrer">
            Read the document (fingerprint verified) ↗
          </a>
          <p className="mt-2 break-all text-xs text-mx-ink-faint">SHA-256: {terms.sha256}</p>
          <p className="mt-2 text-xs text-mx-ink-faint">You accept this exact version in the buy panel before you buy.</p>
        </>
      ) : (
        <p className="mt-2 text-mx-ink-faint">{error ?? "Loading the verified document…"}</p>
      )}
    </section>
  );
}

/** The full risk warning (without its checkbox: that one is in the buy card). */
export function SaleRiskWarningSection() {
  return (
    <section id={SALE_RISK_WARNING_ANCHOR} aria-label={PURCHASE_RISK_WARNING.title} className="scroll-mt-24">
      <PurchaseRiskWarning />
    </section>
  );
}

/**
 * The acceptances directly above the Buy button: this document version (with
 * its status) and the risk warning. Without terms for this sale there is
 * nothing to accept, and the button stays off (lib/sale-page
 * purchaseAcceptanceComplete); the reason is said here.
 */
export function SaleAcceptances({
  terms,
  error,
  acceptedTerms,
  onAcceptedTermsChange,
  acceptedRisk,
  onAcceptedRiskChange,
  onReadRisk,
}: {
  terms: SaleDocumentTerms | null;
  error: string | null;
  acceptedTerms: boolean;
  onAcceptedTermsChange: (value: boolean) => void;
  acceptedRisk: boolean;
  onAcceptedRiskChange: (value: boolean) => void;
  /** Brings the full risk warning (above the page's tabs) into view. */
  onReadRisk?: () => void;
}) {
  if (!terms) {
    return (
      <p data-sale-acceptances="" className="mb-4 rounded-[3px] border border-mx-rule bg-mx-paper px-3 py-2 text-[12px] text-mx-ink-faint">
        {error ?? "Loading the verified document…"}
      </p>
    );
  }
  return (
    <div data-sale-acceptances="" className="mb-4 space-y-3 rounded-[3px] border border-mx-rule bg-mx-paper px-3 py-3 text-[12px] leading-relaxed text-mx-ink-soft">
      <div>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={acceptedTerms}
            onChange={(e) => onAcceptedTermsChange(e.target.checked)}
            className="mt-0.5 accent-emerald-800"
          />
          <span>
            I have read and accept this document version and its stated risks and rights. {statusLine(terms)}
          </span>
        </label>
        <a href={terms.url} target="_blank" rel="noreferrer" className="ml-6 mt-0.5 inline-block font-medium text-mx-ink underline">
          Read the document ↗
        </a>
      </div>
      <div>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={acceptedRisk}
            onChange={(e) => onAcceptedRiskChange(e.target.checked)}
            className="mt-0.5 accent-emerald-800"
          />
          <span>{PURCHASE_RISK_WARNING.acknowledgement}</span>
        </label>
        <a
          href={`#${SALE_RISK_WARNING_ANCHOR}`}
          onClick={(e) => {
            if (!onReadRisk) return;
            e.preventDefault();
            onReadRisk();
          }}
          className="ml-6 mt-0.5 inline-block font-medium text-mx-ink underline"
        >
          Read the {PURCHASE_RISK_WARNING.title.toLowerCase()}
        </a>
      </div>
    </div>
  );
}

/** The compact progress of an on-chain sale: tokens sold of the tokens for sale, buyers, days left. */
export function SoldProgress({
  sold,
  total,
  buyers,
  daysLeft,
  verifiedPayments,
  notes,
}: {
  sold: bigint;
  total: bigint;
  /** Buyers with a verified payment; null when the totals are unavailable. */
  buyers: number | null;
  daysLeft: number;
  /** "1,250 USDC" paid and verified, or null when unknown. */
  verifiedPayments: string | null;
  notes?: ReactNode;
}) {
  const p = soldProgress(sold, total);
  return (
    <div data-sale-progress="" className="mt-5 border-t border-mx-rule pt-4">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[13px] text-mx-ink-soft">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mx-ink-faint">{SOLD_LABEL}</span>{" "}
          <span className="font-semibold text-mx-ink">
            {p.sold} / {p.total}
          </span>{" "}
          tokens
        </p>
        <span className={`text-[13px] font-semibold ${p.percent >= 90 ? "text-emerald-600" : "text-mx-ink-soft"}`}>{p.percent}% sold</span>
      </div>
      {total > BigInt(0) && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-mx-indigo-soft">
          <div
            className={`h-full rounded-full transition-all duration-700 ${p.percent >= 90 ? "bg-emerald-500" : "bg-mx-indigo"}`}
            style={{ width: `${p.percent}%` }}
          />
        </div>
      )}
      <div className="mt-3 flex items-center justify-between text-[12px] text-mx-ink-faint">
        <span>
          Buyers <span className="font-semibold text-mx-ink">{buyers === null ? "—" : buyers}</span>
        </span>
        <span>
          Days left{" "}
          <span className={`font-semibold ${daysLeft > 0 && daysLeft <= 7 ? "text-rose-600" : "text-mx-ink"}`}>
            {daysLeft > 0 ? daysLeft : "—"}
          </span>
        </span>
      </div>
      {verifiedPayments !== null && <p className="mt-1 text-[11px] text-mx-ink-faint">Verified payments: {verifiedPayments}</p>}
      {notes}
    </div>
  );
}
