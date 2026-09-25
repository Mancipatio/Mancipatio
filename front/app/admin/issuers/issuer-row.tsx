"use client";

import Link from "next/link";
import { useEffect, useId, useRef, type ReactNode, type Ref } from "react";
import type { Issuer } from "@/lib/generated/asset_registry";
import {
  isPendingKyb,
  kybDossierHref,
  kybLabel,
  type KybOverride,
} from "@/lib/issuer-directory";

const STATUS_BADGE: Record<number, string> = {
  0: "bg-amber-100 text-amber-800 border-amber-200",
  1: "bg-emerald-100 text-emerald-800 border-emerald-200",
  2: "bg-red-100 text-red-800 border-red-200",
  3: "bg-slate-100 text-slate-700 border-slate-300",
};

/** The directory table's column count (the detail row spans all of them). */
export const ISSUER_TABLE_COLUMNS = 5;

/**
 * One issuer of the /admin/issuers table: its row and, when open, the review
 * detail in a full-width row directly underneath. Both live in their own
 * <tbody> so the pair scrolls into view together. The Review button is the
 * keyboard control (a native button: Enter / Space toggles, aria-expanded
 * says which); clicking anywhere else on the row also toggles.
 */
export function IssuerRowGroup({
  issuer,
  legalId,
  sync,
  expanded,
  groupRef,
  onToggle,
  children,
}: {
  issuer: Issuer;
  legalId: string;
  /** Set while the row shows a chain status the indexer has not caught up to. */
  sync: KybOverride["phase"] | null;
  expanded: boolean;
  groupRef?: Ref<HTMLTableSectionElement>;
  onToggle: () => void;
  /** The review detail, rendered while expanded. */
  children?: ReactNode;
}) {
  const detailId = useId();
  const reviewButton = useRef<HTMLButtonElement | null>(null);
  const wasExpanded = useRef(expanded);
  const pending = isPendingKyb(issuer);
  const authority = issuer.authority.toString();
  const name = legalId || "—";

  // Closing from inside the detail (its Close button) drops the focus with
  // the unmounted detail: hand it back to the row's Review button.
  useEffect(() => {
    if (wasExpanded.current && !expanded) {
      const active = document.activeElement;
      if (!active || active === document.body) reviewButton.current?.focus();
    }
    wasExpanded.current = expanded;
  }, [expanded]);

  return (
    <tbody
      ref={groupRef}
      className="scroll-mt-[calc(16px+var(--maintenance-banner-h,0px))] border-t border-slate-100 first-of-type:border-t-0"
    >
      <tr
        onClick={onToggle}
        className={`cursor-pointer transition-colors ${
          expanded
            ? "bg-slate-50"
            : pending
              ? "bg-amber-50/40 hover:bg-amber-50/70"
              : "hover:bg-slate-50/60"
        }`}
      >
        <td className="px-4 py-3">
          <p className="font-medium text-slate-900">
            {name}
            {pending && (
              <span className="ml-2 inline-flex rounded-full border border-amber-200 bg-amber-50 px-1.5 py-px align-middle text-[10px] font-semibold uppercase tracking-wide text-amber-800">
                Needs review
              </span>
            )}
          </p>
          <p
            className="mt-0.5 font-mono text-[11px] text-slate-500"
            title={authority}
          >
            {authority.slice(0, 6)}…{authority.slice(-4)}
          </p>
        </td>
        <td className="hidden px-4 py-3 text-slate-700 sm:table-cell">
          {issuer.jurisdiction}
        </td>
        <td className="px-4 py-3">
          <span
            className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
              STATUS_BADGE[issuer.kybStatus] ?? STATUS_BADGE[0]
            }`}
          >
            {kybLabel(issuer.kybStatus)}
          </span>
          {sync === "syncing" && (
            <span className="ml-2 text-[11px] text-slate-400">syncing…</span>
          )}
          {sync === "chain" && (
            <span
              className="ml-2 text-[11px] text-slate-400"
              title="Read from the chain; the indexer has not caught up yet."
            >
              on-chain
            </span>
          )}
        </td>
        <td className="hidden px-4 py-3 text-right font-mono text-slate-700 sm:table-cell">
          {String(issuer.assetsCount)}
        </td>
        <td className="px-4 py-3">
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
            <Link
              href={kybDossierHref(authority)}
              onClick={(e) => e.stopPropagation()}
              aria-label={`KYB dossier for ${name}`}
              className="whitespace-nowrap text-xs font-medium text-slate-600 underline-offset-2 hover:text-slate-900 hover:underline"
            >
              KYB dossier →
            </Link>
            <button
              ref={reviewButton}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
              aria-expanded={expanded}
              aria-controls={expanded ? detailId : undefined}
              aria-label={`${expanded ? "Close" : "Review"} ${name}`}
              className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                !expanded && pending
                  ? "bg-slate-900 text-white hover:bg-slate-800"
                  : "border border-slate-300 bg-white text-slate-700 hover:border-slate-400"
              }`}
            >
              {expanded ? "Close" : "Review"}
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-slate-50">
          <td colSpan={ISSUER_TABLE_COLUMNS} className="px-3 pb-4 pt-1 sm:px-4">
            <div id={detailId} role="region" aria-label={`${name} review`}>
              {children}
            </div>
          </td>
        </tr>
      )}
    </tbody>
  );
}
