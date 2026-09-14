import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * Dashed placeholder for a surface that is real but not yet populated —
 * the whitepapers index, an offerings list. Say plainly that it is empty and
 * what will fill it; never fake a row.
 *
 * ```tsx
 * <EmptyState
 *   title="No whitepapers published yet."
 *   hint="Each issuance will appear here once approved."
 * />
 * ```
 */
export function EmptyState({
  title,
  hint,
  children,
  className,
}: {
  title: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("mx-empty", className)}>
      <p>{title}</p>
      {hint ? <p className="mx-small mt-1.5">{hint}</p> : null}
      {children}
    </div>
  );
}
