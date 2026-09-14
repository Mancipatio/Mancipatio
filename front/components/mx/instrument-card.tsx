import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * Value tone.
 * - `neutral`  — a settled fact ("Required", "EUR 3,000,000 per SPV").
 * - `na`       — genuinely not applicable to this instrument.
 * - `pending`  — INTERNAL PREVIEW ONLY. Amber. Never publish it: an issuer
 *   reading "pending legal" concludes we don't know the terms of our own
 *   product. On the live site an unresolved field is simply absent — which
 *   is what passing `value: null` does (see below).
 */
export type MxValueTone = "neutral" | "na" | "pending";

export type InstrumentRow = {
  label: string;
  /**
   * `null` / `undefined` / `""` → **the row is not rendered at all**. That is
   * the production behaviour for an unresolved fact: no row, no "TBD", no
   * "pending". If every row drops out, the whole card renders nothing.
   */
  value?: string | null;
  tone?: MxValueTone;
};

export const MX_TONE_CLASS: Record<MxValueTone, string | false> = {
  neutral: false,
  na: "mx-na",
  pending: "mx-pending",
};

/**
 * "Terms at a glance" — the one distinctive device on the site. A heavy ink
 * frame, a mono header, and ruled key/value rows. The same field list on
 * every instrument page, fed from one data source, so two pages can never
 * disagree.
 *
 * ```tsx
 * <InstrumentCard
 *   title="Company ownership"
 *   rows={[
 *     { label: "Serbian SPV", value: "Required" },
 *     { label: "Annual cap", value: "EUR 3,000,000 per SPV" },
 *     { label: "Delivery", value: "Not applicable", tone: "na" },
 *     { label: "Whitepaper approval", value: null }, // unresolved → omitted
 *   ]}
 * />
 * ```
 */
export function InstrumentCard({
  title,
  aside,
  rows,
  className,
}: {
  title: ReactNode;
  /** Optional right-hand slot in the mono header, e.g. a `<Badge>`. */
  aside?: ReactNode;
  rows: InstrumentRow[];
  className?: string;
}) {
  const visible = rows.filter(
    (r) => r.value !== null && r.value !== undefined && r.value !== "",
  );

  // Nothing settled yet → render nothing rather than a card full of gaps.
  if (visible.length === 0) return null;

  return (
    <div className={cx("mx-inst", className)}>
      <div className="mx-inst-head">
        <span>{title}</span>
        {aside ? <span>{aside}</span> : null}
      </div>
      {visible.map((r) => (
        <div className="mx-inst-row" key={r.label}>
          <span className="mx-inst-k">{r.label}</span>
          <span className={cx("mx-inst-v", MX_TONE_CLASS[r.tone ?? "neutral"])}>
            {r.value}
          </span>
        </div>
      ))}
    </div>
  );
}
