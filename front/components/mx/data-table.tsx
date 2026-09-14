import type { ReactNode } from "react";
import { cx } from "./cx";
import { MX_TONE_CLASS, type MxValueTone } from "./instrument-card";

/**
 * A cell. A bare string is a neutral value; the object form carries a tone.
 *
 * There is no "unresolved" cell: a comparison table must not publish gaps.
 * If a fact isn't settled, drop the **column** (or the row) from `columns` /
 * `rows` — the same rule the instrument card applies per field.
 */
export type TableCell = string | { value: string; tone?: MxValueTone };

export type TableRow = {
  /** Row header — bold, non-mono, sticky-reading first column. */
  header: string;
  cells: TableCell[];
};

/**
 * The comparison table. Mono data cells, hairline rules, and a wrapper that
 * scrolls horizontally on its own so the page body never does.
 *
 * ```tsx
 * <DataTable
 *   columns={["Instrument", "Serbian SPV", "Annual cap"]}
 *   minWidth={640}
 *   rows={[
 *     { header: "Company ownership",
 *       cells: ["Required", "EUR 3M / SPV / yr"] },
 *     { header: "Fungible assets",
 *       cells: [{ value: "—", tone: "na" }, { value: "—", tone: "na" }] },
 *   ]}
 * />
 * ```
 *
 * `columns[0]` labels the row-header column; `cells` therefore has
 * `columns.length - 1` entries.
 */
export function DataTable({
  columns,
  rows,
  minWidth = 1000,
  caption,
  className,
}: {
  columns: string[];
  rows: TableRow[];
  /** px width below which the wrapper scrolls. */
  minWidth?: number;
  /** Visually hidden table caption — screen readers announce it. */
  caption?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("mx-tablewrap", className)}>
      <table className="mx-table" style={{ minWidth: `${minWidth}px` }}>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.header}>
              <th scope="row">{r.header}</th>
              {r.cells.map((cell, i) => {
                const value = typeof cell === "string" ? cell : cell.value;
                const tone = typeof cell === "string" ? "neutral" : cell.tone;
                return (
                  <td key={i} className={cx(MX_TONE_CLASS[tone ?? "neutral"])}>
                    {value}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
