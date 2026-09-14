import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * 13px note attached to the block above it — a legend under a table, a
 * "typical use" line under an instrument card, a data-handling line above a
 * submit button.
 *
 * ```tsx
 * <FootNote className="mt-4">
 *   A dash means not applicable to this instrument.
 * </FootNote>
 * ```
 */
export function FootNote({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <p className={cx("mx-small", className)}>{children}</p>;
}

/**
 * Site-wide legal disclaimer, set at 12.5px in the faint ink. Used in the
 * footer; may also close a page that discusses risk.
 */
export function Disclaimer({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <p className={cx("mx-disclaim", className)}>{children}</p>;
}
