import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * Square-marker list. The only list style on the site — inside cards
 * (fact sheets) and inside sections ("Before you apply").
 *
 * ```tsx
 * <Bullets items={[
 *   "Company ownership, debt and revenue share are issued through a Serbian SPV.",
 *   "Every application is reviewed by a person, and we can decline for any reason.",
 * ]} />
 * ```
 */
export function Bullets({
  items,
  children,
  className,
}: {
  items?: ReactNode[];
  /** Pass `<li>` children when an item needs inline markup of its own. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <ul className={cx("mx-bullets", className)}>
      {items?.map((b, i) => <li key={i}>{b}</li>)}
      {children}
    </ul>
  );
}
