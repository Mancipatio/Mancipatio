"use client";

import { PURCHASE_RISK_WARNING } from "@/lib/legal/risk-warning";

/**
 * The purchase risk warning (lib/legal/risk-warning.ts, ZDI art. 15(2)). With
 * `onAcknowledgedChange` it carries the checkbox the buyer must tick before a
 * purchase (launchpad sale page, OTC take-offer confirmation); without it,
 * the warning alone (the OTC deal deposit confirmation, where the Deposit
 * button is the confirmation). Controlled: the page owns the acknowledged
 * state and resets it.
 */
export function PurchaseRiskWarning({
  acknowledged,
  onAcknowledgedChange,
  className,
}: {
  acknowledged?: boolean;
  onAcknowledgedChange?: (value: boolean) => void;
  className?: string;
}) {
  const warning = PURCHASE_RISK_WARNING;
  return (
    <div
      className={`rounded-[3px] border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950 ${className ?? ""}`}
      role="note"
      aria-label={warning.title}
    >
      <p className="font-semibold">{warning.title}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-relaxed">
        {warning.points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      {onAcknowledgedChange && (
        <label className="mt-3 flex items-start gap-2">
          <input
            type="checkbox"
            checked={acknowledged ?? false}
            onChange={(e) => onAcknowledgedChange(e.target.checked)}
            className="mt-1 accent-emerald-800"
          />
          <span>{warning.acknowledgement}</span>
        </label>
      )}
    </div>
  );
}
