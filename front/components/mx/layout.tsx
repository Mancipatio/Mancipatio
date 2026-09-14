import type { ReactNode } from "react";
import { cx } from "./cx";

export type GridCols = 2 | 3 | 4;

/**
 * The card grid. 4 columns collapse to 2 under 940px and to 1 under 640px;
 * 3 and 2 do the same. There is no other grid on the site.
 *
 * ```tsx
 * <Grid cols={4} className="mt-8">
 *   <Card title="Company ownership" body="Convertible into real shares." />
 * </Grid>
 * ```
 */
export function Grid({
  cols = 3,
  children,
  className,
}: {
  cols?: GridCols;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("mx-grid", `mx-g${cols}`, className)}>{children}</div>
  );
}

/** Two equal columns that stack under 720px — the "Two ways in" pattern. */
export function TwoUp({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cx("mx-two", className)}>{children}</div>;
}
